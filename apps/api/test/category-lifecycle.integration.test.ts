import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { CatalogCategoryManagementService } from '../src/modules/catalog/catalog-category-management.service.js';
import {
  CategoryLifecycleError,
  CategoryLifecyclePolicy,
} from '../src/modules/catalog/category-lifecycle.policy.js';
import { UnintegratedCategoryOfflineExposurePredicate } from '../src/modules/catalog/category-offline-exposure.predicate.js';
import {
  CategoryReferenceScopeError,
  PostgresCategoryServerReferencePredicate,
} from '../src/modules/catalog/category-server-reference.predicate.js';
import { ExpenseCategoryManagementService } from '../src/modules/expenses/expense-category-management.service.js';

describe('category lifecycle preparation', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let organizationA: string;
  let organizationB: string;
  let catalogCategoryA: string;
  let catalogCategoryB: string;
  let expenseCategoryA: string;
  const lifecycle = new CategoryLifecyclePolicy();
  const offlineExposure = new UnintegratedCategoryOfflineExposurePredicate();
  const references = new PostgresCategoryServerReferencePredicate();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    organizationA = randomUUID();
    organizationB = randomUUID();
    catalogCategoryA = randomUUID();
    catalogCategoryB = randomUUID();
    expenseCategoryA = randomUUID();
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Lifecycle A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Lifecycle B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );
    await pool.query(
      `INSERT INTO catalog_categories (id, organization_id, name) VALUES
       ($1, $2, 'Catalog A'), ($3, $4, 'Catalog B')`,
      [catalogCategoryA, organizationA, catalogCategoryB, organizationB],
    );
    await pool.query(
      `INSERT INTO expense_categories (id, organization_id, name) VALUES
       ($1, $2, 'Expense A')`,
      [expenseCategoryA, organizationA],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('keeps append-only server reference evidence for both category domains', async () => {
    await expect(inTenant(organizationA, (client) => references.check(client, {
      categoryId: catalogCategoryA,
      categoryKind: 'CATALOG',
      organizationId: organizationA,
    }))).resolves.toBe(false);
    await expect(inTenant(organizationA, (client) => references.check(client, {
      categoryId: expenseCategoryA,
      categoryKind: 'EXPENSE',
      organizationId: organizationA,
    }))).resolves.toBe(false);

    const catalogReferenceId = randomUUID();
    const expenseReferenceId = randomUUID();
    await inTenant(organizationA, async (client) => {
      await client.query(
        `INSERT INTO catalog_category_history_references
           (id, organization_id, category_id, reference_type, source_id)
         VALUES ($1, $2, $3, 'SALE_SNAPSHOT', $4)`,
        [catalogReferenceId, organizationA, catalogCategoryA, randomUUID()],
      );
      await client.query(
        `INSERT INTO expense_category_history_references
           (id, organization_id, category_id, reference_type, source_id)
         VALUES ($1, $2, $3, 'EXPENSE', $4)`,
        [expenseReferenceId, organizationA, expenseCategoryA, randomUUID()],
      );
    });

    await expect(inTenant(organizationA, (client) => references.check(client, {
      categoryId: catalogCategoryA,
      categoryKind: 'CATALOG',
      organizationId: organizationA,
    }))).resolves.toBe(true);
    await expect(inTenant(organizationA, (client) => references.check(client, {
      categoryId: expenseCategoryA,
      categoryKind: 'EXPENSE',
      organizationId: organizationA,
    }))).resolves.toBe(true);

    await expect(pool.query(
      'DELETE FROM catalog_category_history_references WHERE organization_id = $1 AND id = $2',
      [organizationA, catalogReferenceId],
    )).rejects.toThrow(/append-only/i);
    await expect(pool.query(
      'UPDATE expense_category_history_references SET reference_type = $1 WHERE organization_id = $2 AND id = $3',
      ['VOIDED_EXPENSE', organizationA, expenseReferenceId],
    )).rejects.toThrow(/append-only/i);
  });

  it('allows status transitions despite history or exposure but classifies every deletion barrier', () => {
    expect(lifecycle.requireStatusTransition({ currentStatus: 'ACTIVE', targetStatus: 'INACTIVE' }))
      .toEqual({ status: 'INACTIVE' });
    expect(lifecycle.requireStatusTransition({ currentStatus: 'INACTIVE', targetStatus: 'ACTIVE' }))
      .toEqual({ status: 'ACTIVE' });

    expect(() => lifecycle.requirePhysicalDeletion({
      hasServerReferences: true,
      offlineSafety: 'BARRIER_CONFIRMED_CLEAR',
    })).toThrow(expect.objectContaining({ code: 'CATEGORY_DELETE_BLOCKED_BY_HISTORY' }));
    expect(() => lifecycle.requirePhysicalDeletion({
      hasServerReferences: false,
      offlineSafety: 'EXPOSED',
    })).toThrow(expect.objectContaining({ code: 'CATEGORY_DELETE_BLOCKED_BY_OFFLINE_EXPOSURE' }));
    expect(() => lifecycle.requirePhysicalDeletion({
      hasServerReferences: false,
      offlineSafety: 'NOT_INTEGRATED',
    })).toThrow(expect.objectContaining({ code: 'CATEGORY_DELETE_BARRIER_NOT_INTEGRATED' }));
    expect(lifecycle.requirePhysicalDeletion({
      hasServerReferences: false,
      offlineSafety: 'BARRIER_CONFIRMED_CLEAR',
    })).toEqual({ deletable: true });
  });

  it('reports offline exposure safety as not integrated until the D01 barrier exists', async () => {
    await expect(offlineExposure.check({
      categoryId: catalogCategoryA,
      categoryKind: 'CATALOG',
      organizationId: organizationA,
    })).resolves.toBe('NOT_INTEGRATED');
  });

  it('does not expose physical deletion and rejects cross-tenant reference checks', async () => {
    expect('delete' in CatalogCategoryManagementService.prototype).toBe(false);
    expect('delete' in ExpenseCategoryManagementService.prototype).toBe(false);
    expect('deletePhysically' in CatalogCategoryManagementService.prototype).toBe(true);
    expect('deletePhysically' in ExpenseCategoryManagementService.prototype).toBe(false);

    await expect(inTenant(organizationA, (client) => references.check(client, {
      categoryId: catalogCategoryB,
      categoryKind: 'CATALOG',
      organizationId: organizationA,
    }))).rejects.toBeInstanceOf(CategoryReferenceScopeError);
    expect(() => lifecycle.requireStatusTransition({ currentStatus: 'ACTIVE', targetStatus: 'ACTIVE' }))
      .toThrow(CategoryLifecycleError);
  });

  async function inTenant<TResult>(
    organizationId: string,
    operation: (client: PoolClient) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE uco_app');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      const result = await operation(client);
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
