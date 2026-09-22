import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import {
  ExpenseCategoryManagementError,
  ExpenseCategoryManagementService,
} from '../src/modules/expenses/expense-category-management.service.js';
import {
  ExpenseCategorySelectionError,
  ExpenseCategorySelectionPolicy,
} from '../src/modules/expenses/expense-category-selection.policy.js';

describe('expense category management', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let service: ExpenseCategoryManagementService;
  let organizationA: string;
  let organizationB: string;
  let ownerUserId: string;
  let adminUserId: string;
  let cashierUserId: string;
  const selectionPolicy = new ExpenseCategorySelectionPolicy();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'uco_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    service = new ExpenseCategoryManagementService(new TenantTransaction(runtimePool));
    organizationA = randomUUID();
    organizationB = randomUUID();
    ownerUserId = randomUUID();
    adminUserId = randomUUID();
    cashierUserId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'expense-owner@example.com', '$argon2id$v=19$owner', 1),
       ($2, 'expense-admin@example.com', '$argon2id$v=19$admin', 1),
       ($3, 'expense-cashier@example.com', '$argon2id$v=19$cashier', 1)`,
      [ownerUserId, adminUserId, cashierUserId],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Expenses A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Expenses B', 'ARS', 'America/Argentina/Mendoza')`,
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

  it('keeps expense categories separate from catalog categories and allows selecting only active ones', async () => {
    const active = await service.create(context(ownerUserId, 'expense-category-owner'), { name: '  Servicios  ' });
    await expect(service.create(context(adminUserId, 'expense-category-admin'), { name: 'Logística' }))
      .resolves.toMatchObject({ name: 'Logística', status: 'ACTIVE', version: 1 });

    expect(await pool.query<{ count: string }>(
      'SELECT count(*) FROM catalog_categories WHERE organization_id = $1',
      [organizationA],
    )).toMatchObject({ rows: [{ count: '0' }] });
    await expect(requireActiveCategory(organizationA, ownerUserId, active.id))
      .resolves.toMatchObject({ id: active.id, name: 'Servicios', status: 'ACTIVE' });

    const inactiveId = randomUUID();
    await pool.query(
      `INSERT INTO expense_categories (id, organization_id, name, status)
       VALUES ($1, $2, 'Historical expense', 'INACTIVE')`,
      [inactiveId, organizationA],
    );
    await expect(requireActiveCategory(organizationA, ownerUserId, inactiveId))
      .rejects.toMatchObject({
        code: 'EXPENSE_CATEGORY_INACTIVE',
      } satisfies Partial<ExpenseCategorySelectionError>);
    await expect(requireActiveCategory(organizationA, ownerUserId, randomUUID()))
      .rejects.toMatchObject({
        code: 'EXPENSE_CATEGORY_NOT_AVAILABLE',
      } satisfies Partial<ExpenseCategorySelectionError>);
  });

  it('rejects operational roles and categories from another tenant', async () => {
    await expect(service.create(context(cashierUserId, 'expense-category-cashier'), { name: 'Denied' }))
      .rejects.toMatchObject({
        code: 'EXPENSE_CATEGORY_MANAGEMENT_FORBIDDEN',
      } satisfies Partial<ExpenseCategoryManagementError>);

    const foreignCategoryId = randomUUID();
    await pool.query(
      `INSERT INTO expense_categories (id, organization_id, name, status)
       VALUES ($1, $2, 'Foreign expense', 'ACTIVE')`,
      [foreignCategoryId, organizationB],
    );
    await expect(requireActiveCategory(organizationA, ownerUserId, foreignCategoryId))
      .rejects.toMatchObject({
        code: 'EXPENSE_CATEGORY_NOT_AVAILABLE',
      } satisfies Partial<ExpenseCategorySelectionError>);
  });

  function context(userId: string, requestId: string) {
    return { organizationId: organizationA, requestId, userId };
  }

  async function requireActiveCategory(organizationId: string, userId: string, expenseCategoryId: string) {
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      await client.query("SELECT set_config('app.request_id', $1, true)", [`expense:${expenseCategoryId}`]);
      const result = await selectionPolicy.requireActive(client, organizationId, expenseCategoryId);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
});
