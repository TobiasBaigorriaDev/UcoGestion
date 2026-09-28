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

describe('report HTTP datasets', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let previousUrl: string | undefined;
  const organizationId = randomUUID();
  const branchId = randomUUID();
  const ownerEmail = 'reports-http-owner@example.com';
  const employeeEmail = 'reports-http-employee@example.com';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const owner = await createGlobalUser(pool, { email: ownerEmail, password: 'correct-password' });
    const employee = await createGlobalUser(pool,
      { email: employeeEmail, password: 'correct-password' });
    await pool.query("INSERT INTO organizations (id,name,base_currency,timezone) VALUES ($1,'Reportes','ARS','UTC')",
      [organizationId]);
    await pool.query("INSERT INTO branches (id,organization_id,name) VALUES ($1,$2,'Centro')",
      [branchId, organizationId]);
    const employeeMembershipId = randomUUID();
    await pool.query(`INSERT INTO memberships (id,organization_id,user_id,role) VALUES
      ($1,$3,$4,'OWNER'),($2,$3,$5,'EMPLOYEE')`,
    [randomUUID(), employeeMembershipId, organizationId, owner.id, employee.id]);
    await pool.query(`INSERT INTO membership_branches (organization_id,membership_id,branch_id)
      VALUES ($1,$2,$3)`, [organizationId, employeeMembershipId, branchId]);
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

  it('serves six datasets and rejects unknown or malformed filters', async () => {
    const owner = await cookie(ownerEmail);
    for (const dataset of ['sales', 'inventory', 'inventory-movements', 'cash',
      'purchases', 'expenses']) {
      const response = await get(`/api/v1/reports/${dataset}`, owner).expect(200);
      expect(response.body).toMatchObject({ dataset, items: [], nextCursor: null });
    }
    await get('/api/v1/reports/other', owner).expect(400);
    await get('/api/v1/reports/sales?from=2026-09-01&to=2026-08-01', owner).expect(400);
    await get('/api/v1/reports/sales?lowStock=true', owner).expect(400);
    await get('/api/v1/reports/inventory?lowStock=maybe', owner).expect(400);
    await get(`/api/v1/reports/sales?branchId=${randomUUID()}`, owner).expect(403);
  });

  it('enforces report role policy at HTTP boundary', async () => {
    const employee = await cookie(employeeEmail);
    await get('/api/v1/reports/inventory', employee).expect(200);
    await get('/api/v1/reports/inventory-movements', employee).expect(200);
    await get('/api/v1/reports/sales', employee).expect(403);
    await get('/api/v1/reports/expenses', employee).expect(403);
  });

  it('exports only authorized filtered rows and neutralizes executable CSV cells', async () => {
    const categoryId = randomUUID();
    const expenseId = randomUUID();
    const hiddenBranchId = randomUUID();
    await pool.query(`INSERT INTO branches (id,organization_id,name) VALUES ($1,$2,'Oculta')`,
    [hiddenBranchId, organizationId]);
    await pool.query(`INSERT INTO expense_categories (id,organization_id,name)
      VALUES ($1,$2,'Servicios')`, [categoryId, organizationId]);
    await pool.query(`INSERT INTO expenses (id,organization_id,branch_id,
      expense_category_id,actor_user_id,concept,amount,method,currency_code)
      SELECT $1,$2,$3,$4,user_id,'=2+2',5,'TRANSFER','ARS'
      FROM memberships WHERE organization_id = $2 AND role = 'OWNER'`,
    [expenseId, organizationId, branchId, categoryId]);
    await pool.query(`INSERT INTO expenses (id,organization_id,branch_id,
      expense_category_id,actor_user_id,concept,amount,method,currency_code)
      SELECT gen_random_uuid(),$1,$2,$3,user_id,'NO_EXPORTAR',1,'TRANSFER','ARS'
      FROM memberships WHERE organization_id = $1 AND role = 'OWNER'`,
    [organizationId, hiddenBranchId, categoryId]);
    await pool.query(`INSERT INTO expenses (id,organization_id,branch_id,
      expense_category_id,actor_user_id,concept,amount,method,currency_code)
      SELECT gen_random_uuid(),$1,$2,$3,m.user_id,'Fila-' || n::text,1,'TRANSFER','ARS'
      FROM memberships m CROSS JOIN generate_series(1,101) AS n
      WHERE m.organization_id = $1 AND m.role = 'OWNER'`,
    [organizationId, branchId, categoryId]);
    const owner = await cookie(ownerEmail);
    const csv = await get(`/api/v1/reports/expenses/csv?branchId=${branchId}`, owner)
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain("'=2+2");
    expect(csv.text).toContain(expenseId);
    expect(csv.text).toContain('Fila-101');
    expect(csv.text).not.toContain('NO_EXPORTAR');
    const employee = await cookie(employeeEmail);
    await get('/api/v1/reports/expenses/csv', employee).expect(403);
  });

  it('queues a filtered PDF export with CSRF and idempotency and exposes its status', async () => {
    const owner = await cookie(ownerEmail);
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf')
      .set('Cookie', owner).expect(200);
    const post = () => request(app.getHttpServer()).post('/api/v1/reports/expenses/exports')
      .set('Cookie', owner).set('Origin', 'http://localhost:3000')
      .set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string)
      .set('Idempotency-Key', 'report-export-http-1')
      .send({ branchId });
    const created = await post().expect(201);
    expect(created.body).toMatchObject({ status: 'QUEUED', id: expect.any(String) });
    expect((await post().expect(201)).body).toEqual(created.body);
    await request(app.getHttpServer()).post('/api/v1/reports/expenses/exports')
      .set('Cookie', owner).set('Origin', 'http://localhost:3000')
      .set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string)
      .set('Idempotency-Key', 'report-export-http-1')
      .send({ branchId, from: '2026-01-01' }).expect(409);
    const status = await get(`/api/v1/reports/exports/${created.body.id as string}`, owner)
      .expect(200);
    expect(status.body).toMatchObject({ status: 'QUEUED' });
  });
});
