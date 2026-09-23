import { createSign, createVerify, generateKeyPairSync, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { CatalogItemCreationService } from '../src/modules/catalog/catalog-item-creation.service.js';
import { CatalogPriceService } from '../src/modules/catalog/catalog-price.service.js';
import { ConfigurationVersionService } from '../src/modules/offline-sync/configuration-version.service.js';
import { ResourceSafetyService } from '../src/modules/offline-sync/resource-safety.service.js';
import { UnrecoverableDeviceService } from '../src/modules/offline-sync/unrecoverable-device.service.js';

describe('signed configuration versions and offline exposures', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let service: ConfigurationVersionService;
  let items: CatalogItemCreationService;
  let prices: CatalogPriceService;
  let safety: ResourceSafetyService;
  let unrecoverable: UnrecoverableDeviceService;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const safetyOrganizationId = randomUUID();
  const ownerId = randomUUID();
  const deviceId = randomUUID();
  const safetyDeviceId = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const context = (requestId: string) => ({ organizationId, requestId, userId: ownerId });
  const safetyContext = (requestId: string) => ({ organizationId: safetyOrganizationId, requestId, userId: ownerId });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE ROLE uco_exposure_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri());
    url.username = 'uco_exposure_runtime';
    url.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: url.toString() });
    const transactions = new TenantTransaction(runtimePool);
    items = new CatalogItemCreationService(transactions);
    prices = new CatalogPriceService(transactions);
    safety = new ResourceSafetyService(transactions);
    unrecoverable = new UnrecoverableDeviceService(transactions);
    service = new ConfigurationVersionService(transactions, {
      keyId: 'test-p256-1',
      publicKeyPem,
      sign(payload) {
        const signer = createSign('SHA256');
        signer.update(payload);
        signer.end();
        return signer.sign(privateKey).toString('base64');
      },
    });
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
       VALUES ($1, 'configuration-owner@example.com', '$argon2id$v=19$owner', 1)`,
      [ownerId],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone)
       VALUES ($1, 'Config tenant', 'ARS', 'America/Argentina/Mendoza'),
              ($2, 'Other config tenant', 'USD', 'America/Argentina/Mendoza'),
              ($3, 'Safety tenant', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationId, otherOrganizationId, safetyOrganizationId],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role)
       VALUES ($1, $2, $3, 'OWNER'), ($4, $5, $3, 'OWNER')`,
      [randomUUID(), organizationId, ownerId, randomUUID(), safetyOrganizationId],
    );
    await pool.query(
      'INSERT INTO devices (id, organization_id, status, public_key) VALUES ($1, $2, $3, $4)',
      [deviceId, organizationId, 'ACTIVE', publicKeyPem],
    );
    await pool.query(
      'INSERT INTO devices (id, organization_id, status, public_key) VALUES ($1, $2, $3, $4)',
      [safetyDeviceId, safetyOrganizationId, 'ACTIVE', publicKeyPem],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('signs an immutable tenant snapshot and records an exposure before returning it', async () => {
    const item = await items.create(context('config-item'), { name: 'Offline item', type: 'PRODUCT' });
    await prices.setPrice(context('config-item-price'), item.id, 1, '9.99');
    const issued = await service.issue(context('config-issue'));
    expect(issued.version).toBe(1);
    expect(issued.snapshot.currency).toBe('ARS');
    expect(issued.snapshot.items).toContainEqual(expect.objectContaining({
      id: item.id, price: '9.99', priceVersion: 1,
    }));
    const verifier = createVerify('SHA256');
    verifier.update(issued.canonicalPayload);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(issued.signature, 'base64'))).toBe(true);

    const grantId = randomUUID();
    await pool.query(
      `INSERT INTO offline_grants (id, organization_id, device_id, epoch, configuration_version, expires_at)
       VALUES ($1, $2, $3, 1, $4, now() + interval '72 hours')`,
      [grantId, organizationId, deviceId, issued.version],
    );
    const exposed = await service.recordExposure(context('config-expose'), grantId);
    expect(exposed.version).toBe(issued.version);
    expect((await service.recordExposure(context('config-expose-retry'), grantId)).id).toBe(exposed.id);
    expect((await pool.query(
      'SELECT count(*)::integer AS count FROM offline_exposure_resources WHERE exposure_id = $1 AND catalog_item_id = $2',
      [exposed.id, item.id],
    )).rows[0]?.count).toBe(1);
    await expect(pool.query(
      'DELETE FROM configuration_versions WHERE organization_id = $1 AND version = $2',
      [organizationId, issued.version],
    )).rejects.toThrow();
  });

  it('rejects cross-tenant resource references at the database boundary', async () => {
    const foreignItemId = randomUUID();
    await pool.query(
      `INSERT INTO catalog_items (id, organization_id, name, type)
       VALUES ($1, $2, 'Foreign', 'PRODUCT')`,
      [foreignItemId, otherOrganizationId],
    );
    const exposure = (await pool.query<{ id: string }>(
      'SELECT id FROM offline_configuration_exposures WHERE organization_id = $1 LIMIT 1',
      [organizationId],
    )).rows[0];
    expect(exposure).toBeDefined();
    await expect(pool.query(
      `INSERT INTO offline_exposure_resources (id, organization_id, exposure_id, catalog_item_id)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), organizationId, exposure?.id, foreignItemId],
    )).rejects.toThrow(/offline_exposure_resources_catalog_item_fk/);
  });

  it('keeps uncertainty after expiry, revocation and loss, and permanently locks currency after an unrecoverable declaration', async () => {
    const item = await items.create(safetyContext('safety-item'), { name: 'Pending offline', type: 'PRODUCT' });
    const issued = await service.issue(safetyContext('safety-issue'));
    const grantId = randomUUID();
    await pool.query(
      `INSERT INTO offline_grants (id, organization_id, device_id, epoch, configuration_version, expires_at)
       VALUES ($1, $2, $3, 1, $4, now() - interval '1 hour')`,
      [grantId, safetyOrganizationId, safetyDeviceId, issued.version],
    );
    // The exposure was registered before delivery; expiration cannot clear it.
    await pool.query(
      `INSERT INTO offline_configuration_exposures
         (id, organization_id, device_id, grant_id, epoch, configuration_version)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [randomUUID(), safetyOrganizationId, safetyDeviceId, grantId, issued.version],
    );
    const exposureId = (await pool.query<{ id: string }>(
      'SELECT id FROM offline_configuration_exposures WHERE grant_id = $1', [grantId],
    )).rows[0]?.id;
    await pool.query(
      `INSERT INTO offline_exposure_resources (id, organization_id, exposure_id, catalog_item_id)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), safetyOrganizationId, exposureId, item.id],
    );
    await pool.query('UPDATE offline_grants SET revoked_at = now() WHERE id = $1', [grantId]);
    expect(await safety.catalogItem(safetyContext('safety-item-check'), item.id)).toBe('UNCERTAIN');
    expect(await safety.currency(safetyContext('safety-currency-check'))).toBe('UNCERTAIN');

    const declaration = await unrecoverable.declare(safetyContext('safety-declare'), safetyDeviceId);
    expect((await unrecoverable.declare(safetyContext('safety-declare'), safetyDeviceId)).declarationId)
      .toBe(declaration.declarationId);
    expect(await safety.currency(safetyContext('safety-currency-permanent'))).toBe('PERMANENT');
    await pool.query("UPDATE devices SET status = 'ACTIVE' WHERE id = $1", [safetyDeviceId]);
    expect(await safety.currency(safetyContext('safety-currency-reappeared'))).toBe('PERMANENT');
    expect(await safety.catalogItem(safetyContext('safety-item-still-pending'), item.id)).toBe('UNCERTAIN');
    await expect(pool.query(
      'UPDATE organizations SET currency_permanently_locked_at = NULL WHERE id = $1', [safetyOrganizationId],
    )).rejects.toThrow(/permanent currency lock/);
  });

  it('retains confirmed resource history even after uncertainty is cleared', async () => {
    const item = await items.create(context('history-item'), { name: 'Historical offline', type: 'PRODUCT' });
    await pool.query(
      `INSERT INTO resource_history_references
         (id, organization_id, catalog_item_id, reference_type, source_id)
       VALUES ($1, $2, $3, 'SALE', $4)`,
      [randomUUID(), organizationId, item.id, randomUUID()],
    );
    expect(await safety.catalogItem(context('history-item-check'), item.id)).toBe('HISTORY');
  });

  it('does not create a permanent lock from a device with no offline exposure', async () => {
    const unexposedDeviceId = randomUUID();
    await pool.query(
      `INSERT INTO devices (id, organization_id, status, public_key)
       VALUES ($1, $2, 'ACTIVE', $3)`,
      [unexposedDeviceId, organizationId, publicKeyPem],
    );
    const result = await unrecoverable.declare(context('unexposed-declare'), unexposedDeviceId);
    expect(result.permanentlyLocked).toBe(false);
    expect((await pool.query(
      'SELECT currency_permanently_locked_at FROM organizations WHERE id = $1',
      [organizationId],
    )).rows[0]?.currency_permanently_locked_at).toBeNull();
  });
});
