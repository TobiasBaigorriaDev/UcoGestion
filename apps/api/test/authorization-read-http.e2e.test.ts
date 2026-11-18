import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';

const roles = ['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE'] as const;
type Role = typeof roles[number];
interface ReadCase { path: string; allowed: readonly Role[]; scoped?: boolean; deniedEmpty?: boolean; outsideEmpty?: boolean }

describe('CHECK-02 protected read HTTP matrix with real memberships and PostgreSQL', () => {
  const org = randomUUID(), foreign = randomUUID(), branch = randomUUID(), outside = randomUUID();
  const ownerAndAdmin: readonly Role[] = ['OWNER', 'ADMIN'];
  const cases: readonly ReadCase[] = [
    { path: 'catalog/items', allowed: roles },
    { path: 'catalog/items/manage', allowed: ownerAndAdmin },
    { path: 'catalog/categories', allowed: ownerAndAdmin },
    { path: 'users/management', allowed: ownerAndAdmin },
    { path: 'organizations/settings', allowed: roles },
    { path: 'customers', allowed: ['OWNER', 'ADMIN', 'CASHIER'] },
    { path: 'suppliers', allowed: ownerAndAdmin },
    { path: 'expense-categories', allowed: ownerAndAdmin },
    { path: 'audit', allowed: ownerAndAdmin },
    { path: 'dashboard', allowed: roles, scoped: true },
    { path: 'inventory/stocks', allowed: roles, scoped: true },
    { path: 'cash-sessions', allowed: ['OWNER', 'ADMIN', 'CASHIER'], scoped: true },
    // Plan §23 intentionally returns an empty page outside sales scope.
    { path: 'sales', allowed: ['OWNER', 'ADMIN', 'CASHIER'], scoped: true, deniedEmpty: true, outsideEmpty: true },
    { path: 'purchases', allowed: ownerAndAdmin, scoped: true, outsideEmpty: true },
    { path: 'reports/inventory', allowed: ['OWNER', 'ADMIN', 'EMPLOYEE'], scoped: true },
  ];
  let app: INestApplication, container: StartedPostgreSqlContainer, pool: Pool;
  const identities = new Map<Role, { membershipId: string; cookie: string }>();
  let priorUrl: string | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("INSERT INTO organizations(id,name,base_currency,timezone) VALUES ($1,'Local','ARS','UTC'),($2,'FOREIGN_PRIVATE_NAME','ARS','UTC')", [org, foreign]);
    await pool.query("INSERT INTO branches(id,organization_id,name) VALUES ($1,$2,'Assigned'),($3,$2,'Outside')", [branch, org, outside]);
    for (const role of roles) {
      const user = await createGlobalUser(pool, { email: `${role.toLowerCase()}@read-matrix.example`, password: 'read-matrix-password' });
      const membershipId = randomUUID();
      await pool.query('INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,$4)', [membershipId, org, user.id, role]);
      if (role !== 'OWNER') await pool.query('INSERT INTO membership_branches(organization_id,membership_id,branch_id) VALUES ($1,$2,$3)', [org, membershipId, branch]);
      identities.set(role, { membershipId, cookie: '' });
    }
    await pool.query("INSERT INTO catalog_items(id,organization_id,name,type) VALUES ($1,$2,'LOCAL_VISIBLE_ITEM','PRODUCT'),($3,$4,'FOREIGN_PRIVATE_ITEM','PRODUCT')", [randomUUID(), org, randomUUID(), foreign]);
    await pool.query("CREATE ROLE read_matrix_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'read_matrix_runtime'; runtimeUrl.password = 'runtime-password';
    priorUrl = process.env.DATABASE_URL; process.env.DATABASE_URL = runtimeUrl.toString();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication()); await app.init();
    for (const role of roles) {
      const login = await request(app.getHttpServer()).post('/api/v1/auth/login')
        .set('Origin', 'http://localhost:3000')
        .send({ email: `${role.toLowerCase()}@read-matrix.example`, password: 'read-matrix-password' }).expect(204);
      const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0];
      const identity = identities.get(role);
      if (!cookie || !identity) throw new Error('Missing authenticated matrix fixture');
      identity.cookie = cookie;
    }
  });
  afterAll(async () => {
    await app?.close(); await pool?.end(); await container?.stop();
    if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
  });
  function read(role: Role, testCase: ReadCase, organizationId = org, selectedBranch = branch) {
    const identity = identities.get(role);
    if (!identity) throw new Error('Missing identity');
    return request(app.getHttpServer()).get(`/api/v1/${testCase.path}`)
      .set('Cookie', identity.cookie).set('X-Organization-Id', organizationId)
      .query(testCase.scoped ? { branchId: selectedBranch } : {});
  }
  for (const testCase of cases) {
    it.each(roles)(`RF-21 GET ${testCase.path} enforces actual %s role, tenant and branch scope`, async role => {
      const allowed = testCase.allowed.includes(role);
      const response = await read(role, testCase).expect(allowed || testCase.deniedEmpty ? 200 : 403);
      expect(JSON.stringify(response.body)).not.toMatch(/FOREIGN_PRIVATE/);
      if (testCase.path === 'catalog/items') expect(response.body.items).toEqual([expect.objectContaining({ name: 'LOCAL_VISIBLE_ITEM' })]);
      if (!allowed && testCase.deniedEmpty) expect(response.body).toMatchObject({ items: [], nextCursor: null });
      if (!allowed && !testCase.deniedEmpty) {
        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.body).toMatchObject({ status: 403, traceId: expect.any(String) });
      }
      const foreignResponse = await read(role, testCase, foreign).expect(403);
      expect(JSON.stringify(foreignResponse.body)).not.toMatch(/FOREIGN_PRIVATE/);
      if (testCase.path === 'dashboard' && (role === 'CASHIER' || role === 'EMPLOYEE')) {
        expect(response.body).not.toHaveProperty('expenses');
        expect(response.body).not.toHaveProperty('purchases');
        expect(response.body).not.toHaveProperty('operatingResult');
        if (role === 'EMPLOYEE') expect(response.body).not.toHaveProperty('sales');
      }
      if (testCase.scoped && allowed) {
        const outOfScope = await read(role, testCase, org, outside)
          .expect(role === 'OWNER' || testCase.outsideEmpty ? 200 : 403);
        if (role !== 'OWNER' && testCase.outsideEmpty) expect(outOfScope.body).toMatchObject({ items: [], nextCursor: null });
      }
    });
  }
  it.each(roles)('RF-04 all listed reads revalidate %s membership after login', async role => {
    const identity = identities.get(role);
    if (!identity) throw new Error('Missing identity');
    await pool.query("UPDATE memberships SET status='INACTIVE',deactivated_at=now() WHERE id=$1", [identity.membershipId]);
    try {
      for (const testCase of cases) await read(role, testCase).expect(403);
    } finally { await pool.query("UPDATE memberships SET status='ACTIVE',deactivated_at=NULL WHERE id=$1", [identity.membershipId]); }
  });
});
