import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import {
  CatalogCategoryManagementError,
  CatalogCategoryManagementService,
} from '../src/modules/catalog/catalog-category-management.service.js';

describe('catalog category management', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let service: CatalogCategoryManagementService;
  let organizationA: string;
  let organizationB: string;
  let ownerUserId: string;
  let adminUserId: string;
  let cashierUserId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'uco_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    service = new CatalogCategoryManagementService(new TenantTransaction(runtimePool));
    organizationA = randomUUID();
    organizationB = randomUUID();
    ownerUserId = randomUUID();
    adminUserId = randomUUID();
    cashierUserId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'catalog-owner@example.com', '$argon2id$v=19$owner', 1),
       ($2, 'catalog-admin@example.com', '$argon2id$v=19$admin', 1),
       ($3, 'catalog-cashier@example.com', '$argon2id$v=19$cashier', 1)`,
      [ownerUserId, adminUserId, cashierUserId],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Catalog A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Catalog B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'ADMIN'), ($6, $2, $7, 'CASHIER')`,
      [randomUUID(), organizationA, ownerUserId, randomUUID(), adminUserId, randomUUID(), cashierUserId],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('creates active catalog categories scoped to the organization', async () => {
    await expect(service.create(context(ownerUserId, 'catalog-category-owner'), { name: '  Bebidas  ' }))
      .resolves.toMatchObject({ name: 'Bebidas', status: 'ACTIVE', version: 1 });
    const adminCategory = await service.create(context(adminUserId, 'catalog-category-admin'), { name: 'Almacén' });

    expect(await pool.query<{ organization_id: string; name: string; status: string }>(
      'SELECT organization_id, name, status FROM catalog_categories WHERE id = $1',
      [adminCategory.id],
    )).toMatchObject({
      rows: [{ organization_id: organizationA, name: 'Almacén', status: 'ACTIVE' }],
    });
    await expect(service.create(
      { organizationId: organizationB, requestId: 'catalog-category-other', userId: ownerUserId },
      { name: 'Bebidas' },
    )).rejects.toMatchObject({
      code: 'CATALOG_CATEGORY_MANAGEMENT_FORBIDDEN',
    } satisfies Partial<CatalogCategoryManagementError>);
  });

  it('rejects blank names and operational roles', async () => {
    await expect(service.create(context(ownerUserId, 'catalog-category-blank'), { name: '   ' }))
      .rejects.toMatchObject({
        code: 'CATALOG_CATEGORY_NAME_INVALID',
      } satisfies Partial<CatalogCategoryManagementError>);
    await expect(service.create(context(cashierUserId, 'catalog-category-cashier'), { name: 'Denied' }))
      .rejects.toMatchObject({
        code: 'CATALOG_CATEGORY_MANAGEMENT_FORBIDDEN',
      } satisfies Partial<CatalogCategoryManagementError>);
  });

  function context(userId: string, requestId: string) {
    return { organizationId: organizationA, requestId, userId };
  }
});
