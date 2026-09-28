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

describe('audit and dashboard HTTP contracts', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let previousUrl: string | undefined;
  const organizationId = randomUUID();
  const branchId = randomUUID();
  const ownerEmail = 'audit-dashboard-owner@example.com';
  const adminEmail = 'audit-dashboard-admin@example.com';
  const cashierEmail = 'audit-dashboard-cashier@example.com';
  const employeeEmail = 'audit-dashboard-employee@example.com';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const [owner, admin, cashier, employee] = await Promise.all([
      createGlobalUser(pool, { email: ownerEmail, password: 'correct-password' }),
      createGlobalUser(pool, { email: adminEmail, password: 'correct-password' }),
      createGlobalUser(pool, { email: cashierEmail, password: 'correct-password' }),
      createGlobalUser(pool, { email: employeeEmail, password: 'correct-password' }),
    ]);
    await pool.query("INSERT INTO organizations (id,name,base_currency,timezone) VALUES ($1,'Demo','ARS','UTC')",
      [organizationId]);
    await pool.query("INSERT INTO branches (id,organization_id,name) VALUES ($1,$2,'Centro')",
      [branchId, organizationId]);
    const adminMembership = randomUUID();
    const cashierMembership = randomUUID();
    const employeeMembership = randomUUID();
    await pool.query(`INSERT INTO memberships (id,organization_id,user_id,role) VALUES
      ($1,$5,$6,'OWNER'),($2,$5,$7,'ADMIN'),($3,$5,$8,'CASHIER'),($4,$5,$9,'EMPLOYEE')`,
    [randomUUID(), adminMembership, cashierMembership, employeeMembership,
      organizationId, owner.id, admin.id, cashier.id, employee.id]);
    await pool.query(`INSERT INTO membership_branches (organization_id,membership_id,branch_id)
      VALUES ($1,$2,$5),($1,$3,$5),($1,$4,$5)`,
    [organizationId, adminMembership, cashierMembership, employeeMembership, branchId]);
    await pool.query(`INSERT INTO audit_events (id,organization_id,actor_user_id,branch_id,
      request_id,operation_id,entity_type,entity_id,action)
      VALUES ($1,$2,$3,$4,'http-event','http-event','branch',$4,'branch.updated')`,
    [randomUUID(), organizationId, owner.id, branchId]);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = container.getConnectionUri();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  async function cookie(email: string) {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3000')
      .send({ email, password: 'correct-password' }).expect(204);
    return (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
  }

  const get = (path: string, sessionCookie: string) => request(app.getHttpServer()).get(path)
    .set('Cookie', sessionCookie).set('X-Organization-Id', organizationId);

  it('enforces audit module authorization and validates filters', async () => {
    const owner = await cookie(ownerEmail);
    const admin = await cookie(adminEmail);
    const cashier = await cookie(cashierEmail);
    const employee = await cookie(employeeEmail);
    expect((await get('/api/v1/audit', owner).expect(200)).body.items)
      .toContainEqual(expect.objectContaining({ requestId: 'http-event' }));
    expect((await get('/api/v1/audit', admin).expect(200)).body.items)
      .toContainEqual(expect.objectContaining({ requestId: 'http-event' }));
    await get('/api/v1/audit', cashier).expect(403);
    await get('/api/v1/audit', employee).expect(403);
    await get('/api/v1/audit?branchId=not-a-uuid', owner).expect(400);
  });

  it('serves role-specific dashboard contracts', async () => {
    const owner = await cookie(ownerEmail);
    const cashier = await cookie(cashierEmail);
    const employee = await cookie(employeeEmail);
    expect((await get('/api/v1/dashboard', owner).expect(200)).body)
      .toMatchObject({ role: 'OWNER', sales: { net: '0.00' } });
    const cashierBody = (await get('/api/v1/dashboard', cashier).expect(200)).body;
    expect(cashierBody).toMatchObject({ role: 'CASHIER', sales: { net: '0.00' } });
    expect(cashierBody).not.toHaveProperty('expenses');
    const employeeBody = (await get('/api/v1/dashboard', employee).expect(200)).body;
    expect(employeeBody).toMatchObject({ role: 'EMPLOYEE', catalog: [], inventory: [] });
    expect(employeeBody).not.toHaveProperty('sales');
    await get('/api/v1/dashboard?from=invalid', owner).expect(400);
    await get(`/api/v1/dashboard?branchId=${randomUUID()}`, cashier).expect(403);
  });
});
