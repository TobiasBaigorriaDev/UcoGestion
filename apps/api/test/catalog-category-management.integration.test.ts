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

  it.each(['OWNER', 'ADMIN'])('T236I: %s edits a global category, versions once and audits an idempotent replay', async role => {
    const userId = role === 'OWNER' ? ownerUserId : adminUserId;
    const ctx = context(userId, `category-edit-${role}`);
    const category = await service.create(ctx, { name: `Original ${role}` }, randomUUID());
    const epoch = (await pool.query('SELECT config_epoch FROM organizations WHERE id=$1', [organizationA])).rows[0];
    const key = randomUUID();
    // Compare audit timestamps with their source clock, not the host/container clock offset.
    const startedAt = (await pool.query<{ time: Date }>('SELECT clock_timestamp() AS time')).rows[0]?.time.getTime();
    if (startedAt === undefined) throw new Error('Database clock unavailable');
    const edited = await service.update(ctx, category.id, 1, { name: '  Renombrada  ' }, key);
    expect(edited).toEqual({ ...category, name: 'Renombrada', version: 2 });
    expect(await service.update(ctx, category.id, 1, { name: 'Renombrada' }, key)).toEqual(edited);
    expect((await pool.query('SELECT config_epoch FROM organizations WHERE id=$1', [organizationA])).rows[0]?.config_epoch)
      .toBe(String(Number(epoch?.config_epoch) + 1));
    const audits = await pool.query('SELECT * FROM audit_events WHERE entity_id=$1 AND action=$2', [category.id, 'catalog_category.updated']);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({ organization_id: organizationA, actor_user_id: userId,
      request_id: ctx.requestId, branch_id: null, entity_type: 'catalog_category',
      before_data: { name: category.name }, after_data: { name: 'Renombrada' },
      context_data: { categoryId: category.id, version: 2 }, operation_id: expect.any(String), occurred_at: expect.any(Date) });
    expect(audits.rows[0]?.occurred_at.getTime()).toBeGreaterThanOrEqual(startedAt);
    const finishedAt = (await pool.query<{ time: Date }>('SELECT clock_timestamp() AS time')).rows[0]?.time.getTime();
    if (finishedAt === undefined) throw new Error('Database clock unavailable');
    expect(audits.rows[0]?.occurred_at.getTime()).toBeLessThanOrEqual(finishedAt);
    await expect(service.update(ctx, category.id, 1, { name: 'Otro' }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(service.update(ctx, category.id, 1, { name: 'Otro' }, randomUUID())).rejects.toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 });
    await expect(service.update(ctx, category.id, 2, { name: ' ' }, randomUUID())).rejects.toMatchObject({ code: 'CATALOG_CATEGORY_NAME_INVALID' });
    expect((await pool.query('SELECT name,version FROM catalog_categories WHERE id=$1', [category.id])).rows)
      .toEqual([{ name: 'Renombrada', version: '2' }]);
  });

  it('T236I: denies editing by operational roles, absent membership and foreign category without effects', async () => {
    const employeeId = randomUUID();
    await pool.query("INSERT INTO users(id,email_normalized,password_hash,password_hash_version) VALUES ($1,'category-employee@example.com',$2,1)", [employeeId, '$argon2id$v=19$employee']);
    await pool.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,'EMPLOYEE')", [randomUUID(), organizationA, employeeId]);
    const category = await service.create(context(ownerUserId, 'negative-create'), { name: 'Protected' }, randomUUID());
    for (const userId of [cashierUserId, employeeId]) {
      await expect(service.update(context(userId, 'negative-edit'), category.id, 1, { name: 'Denied' }, randomUUID()))
        .rejects.toMatchObject({ code: 'CATALOG_CATEGORY_MANAGEMENT_FORBIDDEN' });
    }
    await expect(service.update({ organizationId: organizationB, userId: ownerUserId, requestId: 'foreign' }, category.id, 1, { name: 'Denied' }, randomUUID()))
      .rejects.toMatchObject({ code: 'CATALOG_CATEGORY_MANAGEMENT_FORBIDDEN' });
    const foreign = randomUUID();
    await pool.query("INSERT INTO catalog_categories(id,organization_id,name) VALUES ($1,$2,'Foreign')", [foreign, organizationB]);
    await expect(service.update(context(ownerUserId, 'foreign-resource'), foreign, 1, { name: 'Denied' }, randomUUID()))
      .rejects.toMatchObject({ code: 'CATALOG_CATEGORY_NOT_FOUND' });
    expect((await pool.query('SELECT name,version FROM catalog_categories WHERE id=$1', [category.id])).rows)
      .toEqual([{ name: 'Protected', version: '1' }]);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action='catalog_category.updated' AND entity_id=ANY($1::uuid[])", [[category.id, foreign]])).rowCount).toBe(0);
  });

  it('T236I: concurrent edits with the same version have one winner', async () => {
    const ctx = context(ownerUserId, 'concurrent-edit');
    const category = await service.create(ctx, { name: 'Concurrent' }, randomUUID());
    const results = await Promise.allSettled(['A', 'B'].map(name => service.update(ctx, category.id, 1, { name }, randomUUID())));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
    expect((await pool.query("SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='catalog_category.updated'", [category.id])).rowCount).toBe(1);
  });

  it('T236I: rolls back name, version, epoch and idempotency if audit fails; retry succeeds', async () => {
    const ctx = context(ownerUserId, 'category-audit-failure');
    const category = await service.create(ctx, { name: 'Atomic' }, randomUUID());
    const before = (await pool.query('SELECT * FROM catalog_categories WHERE id=$1', [category.id])).rows;
    const epoch = (await pool.query('SELECT config_epoch FROM organizations WHERE id=$1', [organizationA])).rows;
    const key = randomUUID();
    await pool.query(`CREATE FUNCTION fail_category_edit_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.request_id = 'category-audit-failure' AND NEW.action = 'catalog_category.updated' THEN
        RAISE EXCEPTION 'category audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_category_edit_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_category_edit_audit()`);
    try {
      await expect(service.update(ctx, category.id, 1, { name: 'Atomic edited' }, key)).rejects.toThrow('category audit unavailable');
      expect((await pool.query('SELECT * FROM catalog_categories WHERE id=$1', [category.id])).rows).toEqual(before);
      expect((await pool.query('SELECT config_epoch FROM organizations WHERE id=$1', [organizationA])).rows).toEqual(epoch);
      expect((await pool.query('SELECT 1 FROM idempotency_records WHERE organization_id=$1 AND key=$2', [organizationA, key])).rowCount).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER fail_category_edit_audit ON audit_events; DROP FUNCTION fail_category_edit_audit()');
    }
    await expect(service.update(ctx, category.id, 1, { name: 'Atomic edited' }, key)).resolves.toMatchObject({ version: 2 });
  });

  it('T236I: revalidates permissions on replay after the actor is downgraded', async () => {
    const ctx = context(adminUserId, 'category-replay-revoked');
    const category = await service.create(ctx, { name: 'Replay' }, randomUUID());
    const key = randomUUID();
    await service.update(ctx, category.id, 1, { name: 'Edited replay' }, key);
    await pool.query("UPDATE memberships SET role='EMPLOYEE' WHERE organization_id=$1 AND user_id=$2", [organizationA, adminUserId]);
    try {
      await expect(service.update(ctx, category.id, 1, { name: 'Edited replay' }, key))
        .rejects.toMatchObject({ code: 'CATALOG_CATEGORY_MANAGEMENT_FORBIDDEN' });
    } finally {
      await pool.query("UPDATE memberships SET role='ADMIN' WHERE organization_id=$1 AND user_id=$2", [organizationA, adminUserId]);
    }
  });
});
