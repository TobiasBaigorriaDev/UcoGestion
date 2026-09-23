import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { CatalogCategoryManagementService } from '../src/modules/catalog/catalog-category-management.service.js';
import { CatalogItemCreationService } from '../src/modules/catalog/catalog-item-creation.service.js';
import {
  CatalogItemLifecycleService,
} from '../src/modules/catalog/catalog-item-lifecycle.service.js';
import { CatalogPriceService } from '../src/modules/catalog/catalog-price.service.js';
import { ConfigurationBarrierService } from '../src/modules/offline-sync/configuration-barrier.service.js';
import { ConfigurationVersionService } from '../src/modules/offline-sync/configuration-version.service.js';

describe('catalog item and category lifecycle (T078 - T081A)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let itemCreation: CatalogItemCreationService;
  let itemLifecycle: CatalogItemLifecycleService;
  let categoryManagement: CatalogCategoryManagementService;
  let priceService: CatalogPriceService;
  let barrierService: ConfigurationBarrierService;
  let versionService: ConfigurationVersionService;

  let organizationId: string;
  let otherOrganizationId: string;
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const cashierId = randomUUID();
  const employeeId = randomUUID();

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

  const ownerContext = (requestId = randomUUID(), orgId = organizationId) => ({
    organizationId: orgId,
    requestId,
    userId: ownerId,
  });

  const adminContext = (requestId = randomUUID(), orgId = organizationId) => ({
    organizationId: orgId,
    requestId,
    userId: adminId,
  });

  const cashierContext = (requestId = randomUUID(), orgId = organizationId) => ({
    organizationId: orgId,
    requestId,
    userId: cashierId,
  });

  const employeeContext = (requestId = randomUUID(), orgId = organizationId) => ({
    organizationId: orgId,
    requestId,
    userId: employeeId,
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });

    await pool.query("CREATE ROLE uco_lifecycle_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri());
    url.username = 'uco_lifecycle_runtime';
    url.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: url.toString() });

    const transactions = new TenantTransaction(runtimePool);
    itemCreation = new CatalogItemCreationService(transactions);
    itemLifecycle = new CatalogItemLifecycleService(transactions);
    categoryManagement = new CatalogCategoryManagementService(transactions);
    priceService = new CatalogPriceService(transactions);
    barrierService = new ConfigurationBarrierService(transactions);
    versionService = new ConfigurationVersionService(transactions, {
      keyId: 'lifecycle-test-key',
      publicKeyPem,
      sign(payload) {
        const signer = createSign('SHA256');
        signer.update(payload);
        signer.end();
        return signer.sign(privateKey).toString('base64');
      },
    });

    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'lifecycle-owner@example.com', '$argon2id$v=19$owner', 1),
       ($2, 'lifecycle-admin@example.com', '$argon2id$v=19$admin', 1),
       ($3, 'lifecycle-cashier@example.com', '$argon2id$v=19$cashier', 1),
       ($4, 'lifecycle-employee@example.com', '$argon2id$v=19$employee', 1)`,
      [ownerId, adminId, cashierId, employeeId],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    organizationId = randomUUID();
    otherOrganizationId = randomUUID();

    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Lifecycle Tenant', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Other Tenant', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationId, otherOrganizationId],
    );

    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'),
       ($4, $5, $6, 'ADMIN'),
       ($7, $8, $9, 'CASHIER'),
       ($10, $11, $12, 'EMPLOYEE'),
       ($13, $14, $15, 'OWNER')`,
      [
        randomUUID(), organizationId, ownerId,
        randomUUID(), organizationId, adminId,
        randomUUID(), organizationId, cashierId,
        randomUUID(), organizationId, employeeId,
        randomUUID(), otherOrganizationId, ownerId,
      ],
    );
  });

  describe('T078: Deactivate item with history and prevent new use without altering snapshots', () => {
    it('deactivates an item that has operational history while preserving snapshots', async () => {
      const item = await itemCreation.create(ownerContext(), {
        name: 'Item With History',
        trackInventory: true,
        type: 'PRODUCT',
      });

      // Record operational history reference
      const referenceId = randomUUID();
      await pool.query(
        `INSERT INTO resource_history_references
           (id, organization_id, catalog_item_id, reference_type, source_id)
         VALUES ($1, $2, $3, 'SALE_SNAPSHOT', $4)`,
        [referenceId, organizationId, item.id, randomUUID()],
      );

      const deactivated = await itemLifecycle.changeStatus(
        ownerContext(),
        item.id,
        item.version,
        'INACTIVE',
        randomUUID(),
      );

      expect(deactivated.status).toBe('INACTIVE');
      expect(deactivated.version).toBe(item.version + 1);

      // Verify the history reference is intact
      const historyCheck = await pool.query(
        `SELECT 1 FROM resource_history_references WHERE id = $1`,
        [referenceId],
      );
      expect(historyCheck.rowCount).toBe(1);

      // Can reactivate
      const reactivated = await itemLifecycle.changeStatus(
        ownerContext(),
        item.id,
        deactivated.version,
        'ACTIVE',
        randomUUID(),
      );
      expect(reactivated.status).toBe('ACTIVE');

      // Unchanged status throws error
      await expect(
        itemLifecycle.changeStatus(
          ownerContext(),
          item.id,
          reactivated.version,
          'ACTIVE',
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_ITEM_STATUS_UNCHANGED' }),
      );
    });

    it('deactivates an item even when exposed to an offline device', async () => {
      const item = await itemCreation.create(ownerContext(), {
        name: 'Item Offline Exposed',
        trackInventory: true,
        type: 'PRODUCT',
      });

      // Expose to an offline device
      const deviceId = randomUUID();
      await pool.query(
        `INSERT INTO devices (id, organization_id, status, public_key)
         VALUES ($1, $2, 'ACTIVE', 'dummy-key')`,
        [deviceId, organizationId],
      );
      const versionResult = await versionService.issue(ownerContext());
      const grant = await barrierService.issueGrant(ownerContext(), deviceId, versionResult.version);
      const exposureResult = await pool.query<{ id: string }>(
        `SELECT id FROM offline_configuration_exposures WHERE grant_id = $1`,
        [grant.id],
      );
      await pool.query(
        `INSERT INTO offline_exposure_resources
           (id, organization_id, exposure_id, catalog_item_id)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), organizationId, exposureResult.rows[0]?.id, item.id],
      );

      // RF-306 explicitly permits deactivation of exposed resources
      const deactivated = await itemLifecycle.changeStatus(
        ownerContext(),
        item.id,
        item.version,
        'INACTIVE',
        randomUUID(),
      );

      expect(deactivated.status).toBe('INACTIVE');
    });
  });

  describe('T079: Physical deletion of items and masters only without references or offline exposure', () => {
    it('physically deletes an item without references or offline exposure', async () => {
      const item = await itemCreation.create(ownerContext(), {
        name: 'Item Erroneous Creation',
        type: 'SERVICE',
      });

      const deleted = await itemLifecycle.deletePhysically(
        ownerContext(),
        item.id,
        item.version,
        randomUUID(),
      );

      expect(deleted.deleted).toBe(true);

      const check = await pool.query(
        `SELECT 1 FROM catalog_items WHERE organization_id = $1 AND id = $2`,
        [organizationId, item.id],
      );
      expect(check.rowCount).toBe(0);
    });

    it('blocks physical deletion of an item with operational history', async () => {
      const item = await itemCreation.create(ownerContext(), {
        name: 'Item With History Cannot Delete',
        type: 'PRODUCT',
      });

      await pool.query(
        `INSERT INTO resource_history_references
           (id, organization_id, catalog_item_id, reference_type, source_id)
         VALUES ($1, $2, $3, 'SALE_SNAPSHOT', $4)`,
        [randomUUID(), organizationId, item.id, randomUUID()],
      );

      await expect(
        itemLifecycle.deletePhysically(
          ownerContext(),
          item.id,
          item.version,
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_ITEM_DELETE_BLOCKED_BY_HISTORY' }),
      );
    });

    it('blocks physical deletion of an item with price versions', async () => {
      const item = await itemCreation.create(ownerContext(), {
        name: 'Item With Price Version',
        type: 'PRODUCT',
      });

      await priceService.setPrice(ownerContext(), item.id, item.version, '150.50');

      await expect(
        itemLifecycle.deletePhysically(
          ownerContext(),
          item.id,
          item.version + 1,
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_ITEM_DELETE_BLOCKED_BY_HISTORY' }),
      );
    });

    it('blocks physical deletion of an item with offline uncertainty', async () => {
      const item = await itemCreation.create(ownerContext(), {
        name: 'Item With Uncertainty Cannot Delete',
        type: 'PRODUCT',
      });

      const deviceId = randomUUID();
      await pool.query(
        `INSERT INTO devices (id, organization_id, status, public_key)
         VALUES ($1, $2, 'ACTIVE', 'dummy-key')`,
        [deviceId, organizationId],
      );
      const versionResult = await versionService.issue(ownerContext());
      const grant = await barrierService.issueGrant(ownerContext(), deviceId, versionResult.version);
      const exposureResult = await pool.query<{ id: string }>(
        `SELECT id FROM offline_configuration_exposures WHERE grant_id = $1`,
        [grant.id],
      );
      await pool.query(
        `INSERT INTO offline_exposure_resources
           (id, organization_id, exposure_id, catalog_item_id)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), organizationId, exposureResult.rows[0]?.id, item.id],
      );

      await expect(
        itemLifecycle.deletePhysically(
          ownerContext(),
          item.id,
          item.version,
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_ITEM_DELETE_BLOCKED_BY_OFFLINE_UNCERTAINTY' }),
      );
    });

    it('physically deletes a catalog category only when clear of history and exposure', async () => {
      const category = await categoryManagement.create(ownerContext(), { name: 'Clear Category' });

      const deleted = await categoryManagement.deletePhysically(
        ownerContext(),
        category.id,
        category.version,
        randomUUID(),
      );

      expect(deleted.deleted).toBe(true);

      const check = await pool.query(
        `SELECT 1 FROM catalog_categories WHERE organization_id = $1 AND id = $2`,
        [organizationId, category.id],
      );
      expect(check.rowCount).toBe(0);
    });

    it('blocks physical deletion of a catalog category with history or offline exposure', async () => {
      const catWithHistory = await categoryManagement.create(ownerContext(), { name: 'Category With History' });
      await pool.query(
        `INSERT INTO catalog_category_history_references
           (id, organization_id, category_id, reference_type, source_id)
         VALUES ($1, $2, $3, 'SALE_SNAPSHOT', $4)`,
        [randomUUID(), organizationId, catWithHistory.id, randomUUID()],
      );

      await expect(
        categoryManagement.deletePhysically(
          ownerContext(),
          catWithHistory.id,
          catWithHistory.version,
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATEGORY_DELETE_BLOCKED_BY_HISTORY' }),
      );

      const catWithExposure = await categoryManagement.create(ownerContext(), { name: 'Category Exposed' });
      const deviceId = randomUUID();
      await pool.query(
        `INSERT INTO devices (id, organization_id, status, public_key)
         VALUES ($1, $2, 'ACTIVE', 'dummy-key')`,
        [deviceId, organizationId],
      );
      const versionResult = await versionService.issue(ownerContext());
      const grant = await barrierService.issueGrant(ownerContext(), deviceId, versionResult.version);
      const exposureResult = await pool.query<{ id: string }>(
        `SELECT id FROM offline_configuration_exposures WHERE grant_id = $1`,
        [grant.id],
      );
      await pool.query(
        `INSERT INTO offline_exposure_resources
           (id, organization_id, exposure_id, catalog_category_id)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), organizationId, exposureResult.rows[0]?.id, catWithExposure.id],
      );

      await expect(
        categoryManagement.deletePhysically(
          ownerContext(),
          catWithExposure.id,
          catWithExposure.version,
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATEGORY_DELETE_BLOCKED_BY_OFFLINE_EXPOSURE' }),
      );
    });
  });

  describe('T080: Change type, trackInventory and baseUnit only without history or uncertainty', () => {
    it('allows structural change when item is clear of history and uncertainty', async () => {
      const item = await itemCreation.create(ownerContext(), {
        name: 'Modifiable Product',
        trackInventory: false,
        type: 'PRODUCT',
      });

      const updated = await itemLifecycle.changeStructural(
        ownerContext(),
        item.id,
        item.version,
        {
          baseUnit: 'FRACTIONAL',
          trackInventory: true,
          type: 'PRODUCT',
        },
        randomUUID(),
      );

      expect(updated.baseUnit).toBe('FRACTIONAL');
      expect(updated.trackInventory).toBe(true);
      expect(updated.version).toBe(item.version + 1);

      // Change from PRODUCT to SERVICE resets trackInventory to false
      const toService = await itemLifecycle.changeStructural(
        ownerContext(),
        item.id,
        updated.version,
        {
          baseUnit: 'UNIT',
          type: 'SERVICE',
        },
        randomUUID(),
      );

      expect(toService.type).toBe('SERVICE');
      expect(toService.trackInventory).toBe(false);
    });

    it('rejects domain invariant violations like trackInventory on SERVICE', async () => {
      const item = await itemCreation.create(ownerContext(), {
        name: 'Service Item',
        type: 'SERVICE',
      });

      await expect(
        itemLifecycle.changeStructural(
          ownerContext(),
          item.id,
          item.version,
          {
            trackInventory: true,
            type: 'SERVICE',
          },
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_ITEM_SERVICE_TRACK_INVENTORY_NOT_ALLOWED' }),
      );
    });

    it('blocks structural change on item with history (both application policy and DB trigger)', async () => {
      const item = await itemCreation.create(ownerContext(), {
        name: 'Historical Item',
        trackInventory: false,
        type: 'PRODUCT',
      });

      await pool.query(
        `INSERT INTO resource_history_references
           (id, organization_id, catalog_item_id, reference_type, source_id)
         VALUES ($1, $2, $3, 'PURCHASE_SNAPSHOT', $4)`,
        [randomUUID(), organizationId, item.id, randomUUID()],
      );

      // Application check
      await expect(
        itemLifecycle.changeStructural(
          ownerContext(),
          item.id,
          item.version,
          {
            trackInventory: true,
            type: 'PRODUCT',
          },
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_ITEM_STRUCTURAL_CHANGE_BLOCKED_BY_HISTORY' }),
      );

      // Direct SQL trigger check
      await expect(
        pool.query(
          `UPDATE catalog_items SET track_inventory = true WHERE id = $1`,
          [item.id],
        ),
      ).rejects.toThrow(/blocked by history/i);
    });

    it('blocks structural change on item with offline uncertainty or active barrier', async () => {
      const item = await itemCreation.create(ownerContext(), {
        name: 'Exposed Item',
        trackInventory: false,
        type: 'PRODUCT',
      });

      const deviceId = randomUUID();
      await pool.query(
        `INSERT INTO devices (id, organization_id, status, public_key)
         VALUES ($1, $2, 'ACTIVE', 'dummy-key')`,
        [deviceId, organizationId],
      );
      const versionResult = await versionService.issue(ownerContext());
      const grant = await barrierService.issueGrant(ownerContext(), deviceId, versionResult.version);
      const exposureResult = await pool.query<{ id: string }>(
        `SELECT id FROM offline_configuration_exposures WHERE grant_id = $1`,
        [grant.id],
      );
      await pool.query(
        `INSERT INTO offline_exposure_resources
           (id, organization_id, exposure_id, catalog_item_id)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), organizationId, exposureResult.rows[0]?.id, item.id],
      );

      await expect(
        itemLifecycle.changeStructural(
          ownerContext(),
          item.id,
          item.version,
          {
            trackInventory: true,
            type: 'PRODUCT',
          },
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_ITEM_STRUCTURAL_CHANGE_BLOCKED_BY_OFFLINE_UNCERTAINTY' }),
      );
    });
  });

  describe('T081: Deactivation preserving references and uncertainty; changing semantic blocked requires new item', () => {
    it('proves that changing blocked semantics requires deactivating old item and creating new one', async () => {
      // 1. Existing item has history
      const originalItem = await itemCreation.create(ownerContext(), {
        barcode: 'OLD-BARCODE-1',
        baseUnit: 'UNIT',
        name: 'Unit Soap',
        sku: 'OLD-SKU-1',
        trackInventory: false,
        type: 'PRODUCT',
      });

      const refId = randomUUID();
      await pool.query(
        `INSERT INTO resource_history_references
           (id, organization_id, catalog_item_id, reference_type, source_id)
         VALUES ($1, $2, $3, 'SALE_SNAPSHOT', $4)`,
        [refId, organizationId, originalItem.id, randomUUID()],
      );

      // 2. Attempting structural change is blocked
      await expect(
        itemLifecycle.changeStructural(
          ownerContext(),
          originalItem.id,
          originalItem.version,
          { baseUnit: 'FRACTIONAL', trackInventory: true, type: 'PRODUCT' },
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_ITEM_STRUCTURAL_CHANGE_BLOCKED_BY_HISTORY' }),
      );

      // 3. User deactivates the original item
      const deactivated = await itemLifecycle.changeStatus(
        ownerContext(),
        originalItem.id,
        originalItem.version,
        'INACTIVE',
        randomUUID(),
      );
      expect(deactivated.status).toBe('INACTIVE');

      // 4. Old item still holds its history references and is not deletable or structurally mutable
      const refCheck = await pool.query(
        `SELECT 1 FROM resource_history_references WHERE id = $1 AND catalog_item_id = $2`,
        [refId, originalItem.id],
      );
      expect(refCheck.rowCount).toBe(1);

      await expect(
        itemLifecycle.deletePhysically(ownerContext(), originalItem.id, deactivated.version, randomUUID()),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_ITEM_DELETE_BLOCKED_BY_HISTORY' }),
      );

      // 5. Create replacement item with desired semantics
      const newItem = await itemCreation.create(ownerContext(), {
        barcode: 'NEW-BARCODE-1',
        baseUnit: 'FRACTIONAL',
        name: 'Fractional Soap',
        sku: 'NEW-SKU-1',
        trackInventory: true,
        type: 'PRODUCT',
      });

      expect(newItem.id).not.toBe(originalItem.id);
      expect(newItem.baseUnit).toBe('FRACTIONAL');
      expect(newItem.trackInventory).toBe(true);
      expect(newItem.status).toBe('ACTIVE');

      // Original item remains unchanged and inactive
      const originalCheck = await pool.query<{ status: string; base_unit: string }>(
        `SELECT status, base_unit FROM catalog_items WHERE id = $1`,
        [originalItem.id],
      );
      expect(originalCheck.rows[0]?.status).toBe('INACTIVE');
      expect(originalCheck.rows[0]?.base_unit).toBe('UNIT');
    });
  });

  describe('T081A: Expose lifecycle of categories and items with permissions, locks, audit, and idempotency', () => {
    it('authorizes OWNER and ADMIN, denounces CASHIER and EMPLOYEE', async () => {
      const item = await itemCreation.create(ownerContext(), { name: 'Role Test Item', type: 'PRODUCT' });

      // ADMIN succeeds
      const adminUpdated = await itemLifecycle.changeStatus(
        adminContext(),
        item.id,
        item.version,
        'INACTIVE',
        randomUUID(),
      );
      expect(adminUpdated.status).toBe('INACTIVE');

      // CASHIER is forbidden
      await expect(
        itemLifecycle.changeStatus(
          cashierContext(),
          item.id,
          adminUpdated.version,
          'ACTIVE',
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_ITEM_LIFECYCLE_FORBIDDEN' }),
      );

      // EMPLOYEE is forbidden
      await expect(
        itemLifecycle.changeStatus(
          employeeContext(),
          item.id,
          adminUpdated.version,
          'ACTIVE',
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_ITEM_LIFECYCLE_FORBIDDEN' }),
      );

      // Category permissions
      const category = await categoryManagement.create(adminContext(), { name: 'Role Category' });
      await expect(
        categoryManagement.changeStatus(
          cashierContext(),
          category.id,
          category.version,
          'INACTIVE',
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_CATEGORY_MANAGEMENT_FORBIDDEN' }),
      );
    });

    it('enforces idempotency on status changes, structural changes, and deletions', async () => {
      const item = await itemCreation.create(ownerContext(), { name: 'Idempotency Item', type: 'PRODUCT' });
      const idempotencyKey = randomUUID();

      // First execution
      const first = await itemLifecycle.changeStatus(
        ownerContext(),
        item.id,
        item.version,
        'INACTIVE',
        idempotencyKey,
      );

      // Replay with identical key returns cached result
      const replay = await itemLifecycle.changeStatus(
        ownerContext(),
        item.id,
        item.version,
        'INACTIVE',
        idempotencyKey,
      );
      expect(replay.version).toBe(first.version);
      expect(replay.status).toBe(first.status);

      // Reusing key with different payload throws error
      await expect(
        itemLifecycle.changeStatus(
          ownerContext(),
          item.id,
          item.version,
          'ACTIVE',
          idempotencyKey,
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }),
      );
    });

    it('records audit events for status change, structural change, and deletion', async () => {
      const item = await itemCreation.create(ownerContext(), { name: 'Audited Item', type: 'PRODUCT' });

      await itemLifecycle.changeStatus(
        ownerContext(),
        item.id,
        item.version,
        'INACTIVE',
        randomUUID(),
      );

      await itemLifecycle.changeStructural(
        ownerContext(),
        item.id,
        item.version + 1,
        { baseUnit: 'FRACTIONAL', type: 'PRODUCT' },
        randomUUID(),
      );

      await itemLifecycle.deletePhysically(
        ownerContext(),
        item.id,
        item.version + 2,
        randomUUID(),
      );

      const audits = await pool.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE organization_id = $1 AND entity_id = $2 ORDER BY occurred_at ASC`,
        [organizationId, item.id],
      );

      const actions = audits.rows.map((r) => r.action);
      expect(actions).toContain('catalog_item.created');
      expect(actions).toContain('catalog_item.status_changed');
      expect(actions).toContain('catalog_item.structural_changed');
      expect(actions).toContain('catalog_item.deleted');
    });

    it('enforces optimistic concurrency control (VERSION_CONFLICT)', async () => {
      const item = await itemCreation.create(ownerContext(), { name: 'Concurrency Item', type: 'PRODUCT' });

      await expect(
        itemLifecycle.changeStatus(
          ownerContext(),
          item.id,
          item.version + 99,
          'INACTIVE',
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'VERSION_CONFLICT' }),
      );
    });

    it('coordinates locks against race conditions with first reference under canonical order', async () => {
      const item = await itemCreation.create(ownerContext(), { name: 'Race Item', type: 'PRODUCT' });

      // Transaction A acquires locks and checks references
      const clientA = await runtimePool.connect();
      try {
        await clientA.query('BEGIN');
        await clientA.query('SET LOCAL ROLE uco_lifecycle_runtime');
        await clientA.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
        await clientA.query("SELECT set_config('app.user_id', $1, true)", [ownerId]);

        // Lock organization epoch then item
        await clientA.query(
          `SELECT config_epoch FROM organizations WHERE id = $1 FOR UPDATE`,
          [organizationId],
        );
        await clientA.query(
          `SELECT id FROM catalog_items WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [organizationId, item.id],
        );

        // Transaction B attempts to insert a reference (which locks catalog_items row via foreign key)
        const insertPromise = pool.query(
          `INSERT INTO resource_history_references
             (id, organization_id, catalog_item_id, reference_type, source_id)
           VALUES ($1, $2, $3, 'SALE_SNAPSHOT', $4)`,
          [randomUUID(), organizationId, item.id, randomUUID()],
        );

        // While A is holding the lock, deletion inside transaction A proceeds
        await clientA.query(
          `DELETE FROM catalog_items WHERE organization_id = $1 AND id = $2`,
          [organizationId, item.id],
        );
        await clientA.query('COMMIT');

        // Transaction B must fail because the referenced catalog item was deleted
        await expect(insertPromise).rejects.toThrow();
      } finally {
        clientA.release();
      }
    });

    it('enforces tenant isolation: cross-tenant access is rejected', async () => {
      const item = await itemCreation.create(ownerContext(), { name: 'Tenant A Item', type: 'PRODUCT' });

      // Attempting to modify from Tenant B
      await expect(
        itemLifecycle.changeStatus(
          ownerContext(randomUUID(), otherOrganizationId),
          item.id,
          item.version,
          'INACTIVE',
          randomUUID(),
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'CATALOG_ITEM_NOT_FOUND' }),
      );
    });
  });
});
