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

describe('inventory HTTP', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let priorUrl: string | undefined;
  const organizationId = randomUUID();
  const branchId = randomUUID();
  const destinationBranchId = randomUUID();
  const itemId = randomUUID();
  const ownerEmail = 'inventory-http-owner@example.com';
  const employeeEmail = 'inventory-http-employee@example.com';
  const cashierEmail = 'inventory-http-cashier@example.com';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const owner = await createGlobalUser(pool, { email: ownerEmail, password: 'correct-password' });
    const employee = await createGlobalUser(pool, { email: employeeEmail, password: 'correct-password' });
    const cashier = await createGlobalUser(pool, { email: cashierEmail, password: 'correct-password' });
    await pool.query("INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'Inventory HTTP', 'ARS', 'UTC')", [organizationId]);
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Principal')", [branchId, organizationId]);
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Destino')", [destinationBranchId, organizationId]);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [randomUUID(), organizationId, owner.id]);
    const employeeMembershipId = randomUUID(); const cashierMembershipId = randomUUID();
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'EMPLOYEE'), ($4, $2, $5, 'CASHIER')",
      [employeeMembershipId, organizationId, employee.id, cashierMembershipId, cashier.id]);
    await pool.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3), ($1, $4, $3)',
      [organizationId, employeeMembershipId, branchId, cashierMembershipId]);
    await pool.query("INSERT INTO catalog_items (id, organization_id, name, type, track_inventory) VALUES ($1, $2, 'Yerba', 'PRODUCT', true)",
      [itemId, organizationId]);
    priorUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = container.getConnectionUri();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close(); await pool?.end(); await container?.stop();
    if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
  });

  it('T105A exposes audited and idempotent increase, decrease and linked compensation', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
      .send({ email: ownerEmail, password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const post = (path: string, key: string) => request(app.getHttpServer()).post(path)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', csrf.body.csrfToken as string)
      .set('Idempotency-Key', key);
    const increaseBody = { branchId, itemId, direction: 'INCREASE', quantity: '3', reason: 'INVENTARIO_INICIAL' };
    const increased = await post('/api/v1/inventory/adjustments', 'inventory-http-increase').send(increaseBody).expect(201);
    expect((await post('/api/v1/inventory/adjustments', 'inventory-http-increase').send(increaseBody).expect(201)).body)
      .toEqual(increased.body);
    await post('/api/v1/inventory/adjustments', 'inventory-http-increase')
      .send({ ...increaseBody, quantity: '4' }).expect(409);
    const decreased = await post('/api/v1/inventory/adjustments', 'inventory-http-decrease')
      .send({ branchId, itemId, direction: 'DECREASE', quantity: '1', reason: 'ROTURA' }).expect(201);
    const compensation = await post(`/api/v1/inventory/adjustments/${decreased.body.id as string}/compensations`, 'inventory-http-comp')
      .send({ observation: 'Se recuperó la unidad' }).expect(201);
    expect(compensation.body).toMatchObject({ branchId, itemId, quantity: '1' });
    expect((await pool.query('SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
      [branchId, itemId])).rows[0]?.quantity).toBe('3.000');
    expect((await pool.query('SELECT count(*)::int AS n FROM inventory_adjustments WHERE item_id = $1',
      [itemId])).rows[0]?.n).toBe(3);
    expect((await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE entity_type = $1 AND entity_id = ANY($2::uuid[])',
      ['inventory_adjustment', [increased.body.id, decreased.body.id, compensation.body.id]])).rows[0]?.n).toBe(3);
  });

  it('T105A enforces adjustment role, reason and branch scope through HTTP', async () => {
    const credentials = async (email: string) => {
      const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
        .send({ email, password: 'correct-password' }).expect(204);
      const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
      const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
      return { cookie, csrfToken: csrf.body.csrfToken as string };
    };
    const post = (auth: { cookie: string; csrfToken: string }, body: object) => request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments').set('Origin', 'http://localhost:3000')
      .set('Cookie', auth.cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', auth.csrfToken).set('Idempotency-Key', randomUUID()).send(body);
    const employee = await credentials(employeeEmail);
    const cashier = await credentials(cashierEmail);
    const body = { branchId, itemId, direction: 'INCREASE', quantity: '1', reason: 'CORRECCION' };
    await post(employee, { ...body, reason: 'INVENTARIO_INICIAL' }).expect(403);
    await post(employee, { ...body, branchId: destinationBranchId }).expect(403);
    await post(employee, body).expect(201);
    await post(cashier, body).expect(403);
    await post(cashier, { ...body, direction: 'DECREASE' }).expect(403);
  });

  it('T107 exposes scoped stock and optional threshold updates', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
      .send({ email: ownerEmail, password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const path = `/api/v1/inventory/stocks/${branchId}/${itemId}`;
    const read = () => request(app.getHttpServer()).get(path).set('Cookie', cookie).set('X-Organization-Id', organizationId);
    expect((await read().expect(200)).body).toMatchObject({ branchId, itemId, threshold: null, lowStock: false });
    const update = () => request(app.getHttpServer()).put(`${path}/threshold`)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string).set('Idempotency-Key', 'threshold-http-set');
    const updated = await update().send({ minimum: '999' }).expect(200);
    expect(updated.body).toMatchObject({ threshold: '999.000', lowStock: true });
    expect((await update().send({ minimum: '999' }).expect(200)).body).toEqual(updated.body);
    await update().send({ minimum: '4' }).expect(409);
  });

  it('T110 transfers atomically with two ledger effects, audit and idempotent replay', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
      .send({ email: ownerEmail, password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const post = (key: string) => request(app.getHttpServer()).post('/api/v1/inventory/transfers')
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string).set('Idempotency-Key', key);
    await request(app.getHttpServer()).post('/api/v1/inventory/adjustments')
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string).set('Idempotency-Key', 'transfer-seed')
      .send({ branchId, itemId, direction: 'INCREASE', quantity: '2', reason: 'INVENTARIO_INICIAL' }).expect(201);
    const balanceBeforeTransfer = (await pool.query<{ quantity: string }>(
      'SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
      [branchId, itemId])).rows[0]?.quantity;
    const body = { originBranchId: branchId, destinationBranchId,
      lines: [{ itemId, quantity: '2' }] };
    const created = await post('transfer-http-once').send(body).expect(201);
    expect((await post('transfer-http-once').send(body).expect(201)).body).toEqual(created.body);
    await post('transfer-http-once').send({ ...body, lines: [{ itemId, quantity: '1' }] }).expect(409);
    expect((await pool.query('SELECT effect_kind, delta FROM inventory_movements WHERE source_id = $1 ORDER BY effect_kind',
      [created.body.id])).rows).toEqual([
      { effect_kind: 'TRANSFER_IN', delta: '2.000' }, { effect_kind: 'TRANSFER_OUT', delta: '-2.000' },
    ]);
    expect((await pool.query('SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
      [destinationBranchId, itemId])).rows[0]?.quantity).toBe('2.000');
    expect((await pool.query('SELECT action FROM audit_events WHERE entity_id = $1',
      [created.body.id])).rows).toEqual([{ action: 'inventory.transfer.confirmed' }]);
    const insufficient = await post('transfer-http-insufficient')
      .send({ ...body, lines: [{ itemId, quantity: '999' }] }).expect(409);
    expect(insufficient.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(insufficient.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', status: 409 });
    expect(insufficient.body.traceId).toEqual(expect.any(String));
    expect((await pool.query('SELECT count(*)::int AS n FROM stock_transfers WHERE organization_id = $1',
      [organizationId])).rows[0]?.n).toBe(1);
    const compensationPath = `/api/v1/inventory/transfers/${created.body.id as string}/compensations`;
    const compensate = (key: string) => request(app.getHttpServer()).post(compensationPath)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string).set('Idempotency-Key', key);
    const reversed = await compensate('transfer-http-compensate').send({}).expect(201);
    expect((await compensate('transfer-http-compensate').send({}).expect(201)).body).toEqual(reversed.body);
    expect((await compensate('transfer-http-compensate-again').send({}).expect(409)).body)
      .toMatchObject({ code: 'TRANSFER_ALREADY_COMPENSATED' });
    expect((await pool.query('SELECT original_transfer_id FROM stock_transfer_compensations WHERE compensation_transfer_id = $1',
      [reversed.body.id])).rows[0]?.original_transfer_id).toBe(created.body.id);
    expect((await pool.query('SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
      [branchId, itemId])).rows[0]?.quantity).toBe(balanceBeforeTransfer);
  });
});
