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

describe('T170 expense HTTP creation', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let previousUrl: string | undefined;
  const organizationId = randomUUID(), branchId = randomUUID(), categoryId = randomUUID();
  const ownerEmail = 'expense-http-owner@example.com';
  const employeeEmail = 'expense-http-employee@example.com';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const owner = await createGlobalUser(pool, { email: ownerEmail, password: 'correct-password' });
    const employee = await createGlobalUser(pool, { email: employeeEmail, password: 'correct-password' });
    await pool.query("INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'Gastos', 'ARS', 'UTC')", [organizationId]);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'EMPLOYEE')", [randomUUID(), organizationId, owner.id, randomUUID(), employee.id]);
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Local')", [branchId, organizationId]);
    await pool.query("INSERT INTO expense_categories (id, organization_id, name) VALUES ($1, $2, 'Servicios')", [categoryId, organizationId]);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = container.getConnectionUri();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });
  afterAll(async () => {
    await app?.close(); await pool?.end(); await container?.stop();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  const identity = async (email: string) => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3000').send({ email, password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    return { cookie, csrf: csrf.body.csrfToken as string };
  };

  it('validates request, idempotency, CSRF and role before creating a noncash expense', async () => {
    const owner = await identity(ownerEmail);
    const post = (cookie: string, csrf: string, key?: string) => {
      const call = request(app.getHttpServer()).post('/api/v1/expenses')
        .set('Origin', 'http://localhost:3000').set('Cookie', cookie)
        .set('X-Organization-Id', organizationId).set('X-CSRF-Token', csrf);
      return key ? call.set('Idempotency-Key', key) : call;
    };
    const body = { branchId, categoryId, concept: 'Alquiler', amount: '20.00', method: 'TRANSFER' };
    await post(owner.cookie, owner.csrf).send(body).expect(428);
    const key = randomUUID();
    const first = await post(owner.cookie, owner.csrf, key).send(body).expect(201);
    expect(first.body).toMatchObject({ branchId, categoryId, amount: '20.00', method: 'TRANSFER' });
    expect((await post(owner.cookie, owner.csrf, key).send(body).expect(201)).body).toEqual(first.body);
    await post(owner.cookie, owner.csrf, key).send({ ...body, amount: '21.00' }).expect(409);
    await post(owner.cookie, owner.csrf, randomUUID()).send({ ...body, amount: '-1' }).expect(400);
    const employee = await identity(employeeEmail);
    await post(employee.cookie, employee.csrf, randomUUID()).send(body).expect(403);
    expect((await pool.query('SELECT count(*)::integer AS n FROM expenses')).rows[0]?.n).toBe(1);
  });
});
