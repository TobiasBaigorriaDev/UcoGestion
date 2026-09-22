import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import {
  CatalogItemCreationError,
  CatalogItemCreationService,
} from '../src/modules/catalog/catalog-item-creation.service.js';

describe('catalog item creation', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let service: CatalogItemCreationService;
  let organizationA: string;
  let organizationB: string;
  let ownerUserId: string;
  let cashierUserId: string;
  let ownerBUserId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'uco_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    service = new CatalogItemCreationService(new TenantTransaction(runtimePool));
    organizationA = randomUUID();
    organizationB = randomUUID();
    ownerUserId = randomUUID();
    cashierUserId = randomUUID();
    ownerBUserId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'catalog-item-owner@example.com', '$argon2id$v=19$owner', 1),
       ($2, 'catalog-item-cashier@example.com', '$argon2id$v=19$cashier', 1),
       ($3, 'catalog-item-owner-b@example.com', '$argon2id$v=19$ownerb', 1)`,
      [ownerUserId, cashierUserId, ownerBUserId],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Catalog items A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Catalog items B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'CASHIER'), ($6, $7, $8, 'OWNER')`,
      [randomUUID(), organizationA, ownerUserId, randomUUID(), cashierUserId, randomUUID(), organizationB, ownerBUserId],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('creates a PRODUCT with a generated internal identifier and required name within its organization', async () => {
    const item = await service.create(context(ownerUserId, 'catalog-item-product'), {
      name: '  Yerba mate  ',
      type: 'PRODUCT',
    });

    expect(item).toMatchObject({
      baseUnit: 'UNIT',
      name: 'Yerba mate',
      status: 'ACTIVE',
      trackInventory: false,
      type: 'PRODUCT',
      version: 1,
    });
    expect(item.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(await pool.query<{ organization_id: string; name: string; type: string; track_inventory: boolean; base_unit: string }>(
      'SELECT organization_id, name, type, track_inventory, base_unit FROM catalog_items WHERE id = $1',
      [item.id],
    )).toMatchObject({
      rows: [{ organization_id: organizationA, name: 'Yerba mate', type: 'PRODUCT', track_inventory: false, base_unit: 'UNIT' }],
    });
    expect(await pool.query<{ action: string; after_data: { name: string; type: string; trackInventory: boolean; baseUnit: string } }>(
      'SELECT action, after_data FROM audit_events WHERE entity_id = $1',
      [item.id],
    )).toMatchObject({
      rows: [{ action: 'catalog_item.created', after_data: { name: 'Yerba mate', type: 'PRODUCT', trackInventory: false, baseUnit: 'UNIT' } }],
    });
  });

  it('configures trackInventory as true or false on PRODUCT respecting UNIT and FRACTIONAL units', async () => {
    const itemUnit = await service.create(context(ownerUserId, 'catalog-item-track-unit'), {
      name: 'Arroz 1kg',
      type: 'PRODUCT',
      trackInventory: true,
      baseUnit: 'UNIT',
    });
    expect(itemUnit).toMatchObject({
      name: 'Arroz 1kg',
      trackInventory: true,
      baseUnit: 'UNIT',
    });
    expect(await pool.query<{ track_inventory: boolean; base_unit: string }>(
      'SELECT track_inventory, base_unit FROM catalog_items WHERE id = $1',
      [itemUnit.id],
    )).toMatchObject({
      rows: [{ track_inventory: true, base_unit: 'UNIT' }],
    });

    const itemFractional = await service.create(context(ownerUserId, 'catalog-item-track-frac'), {
      name: 'Queso por peso',
      type: 'PRODUCT',
      trackInventory: true,
      baseUnit: 'FRACTIONAL',
    });
    expect(itemFractional).toMatchObject({
      name: 'Queso por peso',
      trackInventory: true,
      baseUnit: 'FRACTIONAL',
    });
    expect(await pool.query<{ track_inventory: boolean; base_unit: string }>(
      'SELECT track_inventory, base_unit FROM catalog_items WHERE id = $1',
      [itemFractional.id],
    )).toMatchObject({
      rows: [{ track_inventory: true, base_unit: 'FRACTIONAL' }],
    });

    await expect(service.create(context(ownerUserId, 'catalog-item-invalid-unit'), {
      name: 'Item invalid unit',
      type: 'PRODUCT',
      baseUnit: 'GRAMS' as unknown as 'UNIT',
    })).rejects.toMatchObject({
      code: 'CATALOG_ITEM_BASE_UNIT_INVALID',
    } satisfies Partial<CatalogItemCreationError>);
  });

  it('normalizes and reserves optional SKU uniquely among active and inactive items within the organization', async () => {
    const itemA = await service.create(context(ownerUserId, 'catalog-item-sku-1'), {
      name: 'Item con SKU',
      type: 'PRODUCT',
      sku: '  sku-abc-001  ',
    });
    expect(itemA.sku).toBe('sku-abc-001');

    // Duplicate SKU in same organization with different casing and whitespace is rejected
    await expect(service.create(context(ownerUserId, 'catalog-item-sku-dup'), {
      name: 'Item duplicado SKU',
      type: 'PRODUCT',
      sku: 'SKU-ABC-001',
    })).rejects.toMatchObject({
      code: 'CATALOG_ITEM_SKU_DUPLICATE',
    } satisfies Partial<CatalogItemCreationError>);

    // Deactivating the item still preserves SKU uniqueness reservation
    await pool.query('UPDATE catalog_items SET status = $1 WHERE id = $2', ['INACTIVE', itemA.id]);

    await expect(service.create(context(ownerUserId, 'catalog-item-sku-dup-inactive'), {
      name: 'Item duplicado SKU inactivo',
      type: 'PRODUCT',
      sku: 'sku-abc-001',
    })).rejects.toMatchObject({
      code: 'CATALOG_ITEM_SKU_DUPLICATE',
    } satisfies Partial<CatalogItemCreationError>);

    // Another organization CAN use the same SKU
    const itemOtherTenant = await service.create(
      { organizationId: organizationB, requestId: 'catalog-item-sku-b', userId: ownerBUserId },
      {
        name: 'Item en org B',
        type: 'PRODUCT',
        sku: 'sku-abc-001',
      },
    );
    expect(itemOtherTenant.sku).toBe('sku-abc-001');
  });

  it('normalizes and reserves optional barcode uniquely among active and inactive items within the organization', async () => {
    const itemA = await service.create(context(ownerUserId, 'catalog-item-barcode-1'), {
      name: 'Item con Barcode',
      type: 'PRODUCT',
      barcode: '  7791234567890  ',
    });
    expect(itemA.barcode).toBe('7791234567890');

    // Duplicate barcode in same organization with whitespace is rejected
    await expect(service.create(context(ownerUserId, 'catalog-item-barcode-dup'), {
      name: 'Item duplicado Barcode',
      type: 'PRODUCT',
      barcode: '7791234567890',
    })).rejects.toMatchObject({
      code: 'CATALOG_ITEM_BARCODE_DUPLICATE',
    } satisfies Partial<CatalogItemCreationError>);

    // Deactivating the item still preserves barcode uniqueness reservation
    await pool.query('UPDATE catalog_items SET status = $1 WHERE id = $2', ['INACTIVE', itemA.id]);

    await expect(service.create(context(ownerUserId, 'catalog-item-barcode-dup-inactive'), {
      name: 'Item duplicado Barcode inactivo',
      type: 'PRODUCT',
      barcode: ' 7791234567890 ',
    })).rejects.toMatchObject({
      code: 'CATALOG_ITEM_BARCODE_DUPLICATE',
    } satisfies Partial<CatalogItemCreationError>);

    // Another organization CAN use the same barcode
    const itemOtherTenant = await service.create(
      { organizationId: organizationB, requestId: 'catalog-item-barcode-b', userId: ownerBUserId },
      {
        name: 'Item barcode en org B',
        type: 'PRODUCT',
        barcode: '7791234567890',
      },
    );
    expect(itemOtherTenant.barcode).toBe('7791234567890');
  });

  it('allows creating items with equal or similar names without blocking creation, and provides similar name discovery', async () => {
    const firstItem = await service.create(context(ownerUserId, 'catalog-item-similar-1'), {
      name: 'Galletitas de agua',
      type: 'PRODUCT',
    });
    expect(firstItem.name).toBe('Galletitas de agua');

    // Creating an item with the EXACT SAME name does NOT block creation
    const secondItem = await service.create(context(ownerUserId, 'catalog-item-similar-2'), {
      name: 'Galletitas de agua',
      type: 'PRODUCT',
    });
    expect(secondItem.name).toBe('Galletitas de agua');
    expect(secondItem.id).not.toBe(firstItem.id);

    // Discover similar names
    const matchesExact = await service.findSimilarNames(
      context(ownerUserId, 'catalog-item-similar-search-1'),
      'Galletitas de agua',
    );
    expect(matchesExact).toContain('Galletitas de agua');

    const matchesCaseInsensitive = await service.findSimilarNames(
      context(ownerUserId, 'catalog-item-similar-search-2'),
      'galletitas',
    );
    expect(matchesCaseInsensitive).toContain('Galletitas de agua');

    const noMatches = await service.findSimilarNames(
      context(ownerUserId, 'catalog-item-similar-search-3'),
      'Completamente Diferente',
    );
    expect(noMatches).toHaveLength(0);
  });

  it('requires a name and keeps catalog item creation tenant-scoped', async () => {
    await expect(service.create(context(ownerUserId, 'catalog-item-blank'), {
      name: '   ',
      type: 'PRODUCT',
    })).rejects.toMatchObject({
      code: 'CATALOG_ITEM_NAME_INVALID',
    } satisfies Partial<CatalogItemCreationError>);
    await expect(service.create(
      { organizationId: organizationB, requestId: 'catalog-item-foreign', userId: ownerUserId },
      { name: 'Foreign item', type: 'PRODUCT' },
    )).rejects.toMatchObject({
      code: 'CATALOG_ITEM_CREATION_FORBIDDEN',
    } satisfies Partial<CatalogItemCreationError>);
    await expect(service.create(context(cashierUserId, 'catalog-item-cashier'), {
      name: 'Denied item',
      type: 'PRODUCT',
    })).rejects.toMatchObject({
      code: 'CATALOG_ITEM_CREATION_FORBIDDEN',
    } satisfies Partial<CatalogItemCreationError>);
  });

  it('creates SERVICE without inventory control and rejects trackInventory for it', async () => {
    await expect(service.create(context(ownerUserId, 'catalog-item-service'), {
      name: 'Instalación',
      type: 'SERVICE',
    })).resolves.toMatchObject({ type: 'SERVICE', trackInventory: false });
    await expect(service.create(context(ownerUserId, 'catalog-item-service-inventory'), {
      name: 'Service invalid',
      trackInventory: false,
      type: 'SERVICE',
    })).rejects.toMatchObject({
      code: 'CATALOG_ITEM_SERVICE_TRACK_INVENTORY_NOT_ALLOWED',
    } satisfies Partial<CatalogItemCreationError>);
    await expect(pool.query(
      `INSERT INTO catalog_items (id, organization_id, name, type, track_inventory)
       VALUES ($1, $2, 'Invalid direct service', 'SERVICE', true)`,
      [randomUUID(), organizationA],
    )).rejects.toThrow(/catalog_items_service_track_inventory_check/);
  });

  it('does not expose catalog items from another tenant through the runtime role', async () => {
    const foreignItemId = randomUUID();
    await pool.query(
      `INSERT INTO catalog_items (id, organization_id, name, type)
       VALUES ($1, $2, 'Foreign item', 'PRODUCT')`,
      [foreignItemId, organizationB],
    );

    await expect(new TenantTransaction(runtimePool).read(
      context(ownerUserId, 'catalog-item-rls'),
      async (client) => client.query('SELECT id FROM catalog_items WHERE id = $1', [foreignItemId]),
    )).resolves.toMatchObject({ rows: [] });
  });

  function context(userId: string, requestId: string) {
    return { organizationId: organizationA, requestId, userId };
  }
});
