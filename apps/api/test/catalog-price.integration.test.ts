import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { CatalogItemCreationService } from '../src/modules/catalog/catalog-item-creation.service.js';
import { CatalogPriceService } from '../src/modules/catalog/catalog-price.service.js';

describe('catalog price history', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let items: CatalogItemCreationService;
  let prices: CatalogPriceService;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const ownerId = randomUUID();

  const context = (requestId: string, tenantId = organizationId) => ({
    organizationId: tenantId, requestId, userId: ownerId,
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE ROLE uco_price_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri());
    url.username = 'uco_price_runtime';
    url.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: url.toString() });
    const transaction = new TenantTransaction(runtimePool);
    items = new CatalogItemCreationService(transaction);
    prices = new CatalogPriceService(transaction);
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
       VALUES ($1, 'catalog-price-owner@example.com', '$argon2id$v=19$owner', 1)`,
      [ownerId],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone)
       VALUES ($1, 'Price tenant', 'ARS', 'America/Argentina/Mendoza'),
              ($2, 'Other tenant', 'USD', 'America/Argentina/Mendoza')`,
      [organizationId, otherOrganizationId],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role)
       VALUES ($1, $2, $3, 'OWNER')`,
      [randomUUID(), organizationId, ownerId],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('changes the current price while retaining immutable versions in the organization currency', async () => {
    const item = await items.create(context('price-item'), { name: 'Artículo', type: 'PRODUCT' });

    expect(await prices.setPrice(context('price-first'), item.id, item.version, '10.005'))
      .toMatchObject({ price: '10.01', currency: 'ARS', priceVersion: 1, version: 2 });
    expect(await prices.setPrice(context('price-second'), item.id, 2, '12.00'))
      .toMatchObject({ price: '12.00', currency: 'ARS', priceVersion: 2, version: 3 });

    const versions = await pool.query<{ price: string; currency: string; price_version: string }>(
      `SELECT price::text AS price, currency, price_version::text AS price_version
       FROM catalog_price_versions WHERE organization_id = $1 AND item_id = $2 ORDER BY price_version`,
      [organizationId, item.id],
    );
    expect(versions.rows).toEqual([
      { price: '10.01', currency: 'ARS', price_version: '1' },
      { price: '12.00', currency: 'ARS', price_version: '2' },
    ]);
    expect((await pool.query(
      'SELECT operational_history_started_at FROM organizations WHERE id = $1',
      [organizationId],
    )).rows[0]?.operational_history_started_at).not.toBeNull();
    expect((await pool.query(
      "SELECT count(*)::integer AS count FROM audit_events WHERE entity_id = $1 AND action = 'catalog_item.price_changed'",
      [item.id],
    )).rows[0]?.count).toBe(2);
  });

  it('rejects stale versions, invalid amounts and cross-tenant changes without appending a price', async () => {
    const item = await items.create(context('price-guard-item'), { name: 'Resguardado', type: 'PRODUCT' });
    await expect(prices.setPrice(context('price-invalid'), item.id, 1, '-1.00'))
      .rejects.toMatchObject({ code: 'CATALOG_PRICE_INVALID' });
    await expect(prices.setPrice(context('price-foreign', otherOrganizationId), item.id, 1, '1.00'))
      .rejects.toMatchObject({ code: 'CATALOG_PRICE_FORBIDDEN' });
    await prices.setPrice(context('price-valid'), item.id, 1, '1.00');
    await expect(prices.setPrice(context('price-stale'), item.id, 1, '2.00'))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await pool.query(
      'SELECT count(*)::integer AS count FROM catalog_price_versions WHERE item_id = $1',
      [item.id],
    )).rows[0]?.count).toBe(1);
  });

  it('serializes competing price changes and keeps the history append-only', async () => {
    const item = await items.create(context('price-race-item'), { name: 'Competido', type: 'PRODUCT' });
    const attempts = await Promise.allSettled([
      prices.setPrice(context('price-race-a'), item.id, 1, '3.00'),
      prices.setPrice(context('price-race-b'), item.id, 1, '4.00'),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === 'rejected')?.reason)
      .toMatchObject({ code: 'VERSION_CONFLICT' });

    const version = (await pool.query<{ id: string }>(
      'SELECT id FROM catalog_price_versions WHERE item_id = $1', [item.id],
    )).rows[0];
    expect(version).toBeDefined();
    await expect(pool.query(
      'UPDATE catalog_price_versions SET price = $1 WHERE id = $2', ['5.00', version?.id],
    )).rejects.toThrow(/catalog price versions are append-only/);
    await expect(pool.query(
      'DELETE FROM catalog_price_versions WHERE id = $1', [version?.id],
    )).rejects.toThrow(/catalog price versions are append-only/);
  });
});
