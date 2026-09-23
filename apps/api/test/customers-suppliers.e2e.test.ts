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

describe('customer and supplier HTTP permissions', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let previousDatabaseUrl: string | undefined;
  const organizationId = randomUUID();
  const assignedBranchId = randomUUID();
  const otherBranchId = randomUUID();
  const origin = 'http://localhost:3000';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const owner = await createGlobalUser(pool, {
      email: 'party-owner@example.com', password: 'correct-password',
    });
    const employee = await createGlobalUser(pool, {
      email: 'party-employee@example.com', password: 'correct-password',
    });
    const cashier = await createGlobalUser(pool, {
      email: 'party-cashier@example.com', password: 'correct-password',
    });
    await pool.query(
      "INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'America/Argentina/Mendoza')",
      [organizationId],
    );
    await pool.query(
      `INSERT INTO branches (id, organization_id, name) VALUES
       ($1, $3, 'Asignada'), ($2, $3, 'No asignada')`,
      [assignedBranchId, otherBranchId, organizationId],
    );
    const employeeMembershipId = randomUUID();
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'EMPLOYEE'), ($6, $2, $7, 'CASHIER')`,
      [randomUUID(), organizationId, owner.id, employeeMembershipId, employee.id, randomUUID(), cashier.id],
    );
    await pool.query(
      `INSERT INTO membership_branches (organization_id, membership_id, branch_id)
       VALUES ($1, $2, $3)`,
      [organizationId, employeeMembershipId, assignedBranchId],
    );
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = container.getConnectionUri();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', origin).send({ email, password: 'correct-password' }).expect(204);
    return (response.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
  }

  it('requires idempotency and restricts supplier reception to the assigned branch', async () => {
    const ownerCookie = await login('party-owner@example.com');
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf')
      .set('Cookie', ownerCookie).expect(200);
    const post = (path: string) => request(app.getHttpServer()).post(path)
      .set('Origin', origin)
      .set('Cookie', ownerCookie)
      .set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string);

    await post('/api/v1/customers').send({ name: 'Cliente HTTP' }).expect(428);
    const customer = await post('/api/v1/customers')
      .set('Idempotency-Key', 'customer-http-create')
      .send({ name: 'Cliente HTTP' }).expect(201);
    const customerReplay = await post('/api/v1/customers')
      .set('Idempotency-Key', 'customer-http-create')
      .send({ name: 'Cliente HTTP' }).expect(201);
    expect(customerReplay.body).toEqual(customer.body);
    await request(app.getHttpServer()).get('/api/v1/customers?limit=0')
      .set('Cookie', ownerCookie).set('X-Organization-Id', organizationId).expect(400);

    const supplier = await post('/api/v1/suppliers')
      .set('Idempotency-Key', 'supplier-http-create')
      .send({ name: 'Proveedor HTTP', taxId: '30-12345678-9', notes: 'Privado' }).expect(201);
    const employeeCookie = await login('party-employee@example.com');
    const employeeGet = (path: string) => request(app.getHttpServer()).get(path)
      .set('Cookie', employeeCookie).set('X-Organization-Id', organizationId);
    await employeeGet('/api/v1/customers').expect(403);
    await employeeGet('/api/v1/suppliers').expect(403);
    await employeeGet(`/api/v1/suppliers/reception/${otherBranchId}`).expect(403);
    const reception = await employeeGet(
      `/api/v1/suppliers/reception/${assignedBranchId}/${supplier.body.id as string}`,
    ).expect(200);
    expect(reception.body).toEqual({
      id: supplier.body.id,
      name: 'Proveedor HTTP',
      status: 'ACTIVE',
    });
    const cashierCookie = await login('party-cashier@example.com');
    await request(app.getHttpServer()).get('/api/v1/suppliers')
      .set('Cookie', cashierCookie).set('X-Organization-Id', organizationId).expect(403);
  });
});
