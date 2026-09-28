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

describe('T157 purchase HTTP confirmation', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let previousUrl: string | undefined;
  const organizationId = randomUUID();
  const branchId = randomUUID();
  const supplierId = randomUUID();
  const itemId = randomUUID();
  const ownerEmail = 'purchase-http-owner@example.com';
  const cashierEmail = 'purchase-http-cashier@example.com';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const owner = await createGlobalUser(pool, { email: ownerEmail, password: 'correct-password' });
    const cashier = await createGlobalUser(pool, { email: cashierEmail, password: 'correct-password' });
    await pool.query("INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'Compras', 'ARS', 'UTC')", [organizationId]);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'CASHIER')", [randomUUID(), organizationId, owner.id, randomUUID(), cashier.id]);
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Local')", [branchId, organizationId]);
    await pool.query("INSERT INTO suppliers (id, organization_id, name) VALUES ($1, $2, 'Proveedor')", [supplierId, organizationId]);
    await pool.query("INSERT INTO catalog_items (id, organization_id, name, type, track_inventory, base_unit, price, price_version) VALUES ($1, $2, 'Producto', 'PRODUCT', true, 'UNIT', '1.00', 1)", [itemId, organizationId]);
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

  it('exposes pending confirmation with replay and rejects CASHIER and invalid lines', async () => {
    const owner = await identity(ownerEmail);
    const post = (cookie: string, csrf: string, key: string) => request(app.getHttpServer())
      .post('/api/v1/purchases').set('Origin', 'http://localhost:3000').set('Cookie', cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', key);
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '2', unitCost: '3.25' }] };
    const key = randomUUID();
    const first = await post(owner.cookie, owner.csrf, key).send(input).expect(201);
    expect(first.body).toMatchObject({ id: input.clientOperationId, status: 'PENDING_PAYMENT', total: '6.50' });
    expect((await post(owner.cookie, owner.csrf, key).send(input).expect(201)).body).toEqual(first.body);
    await post(owner.cookie, owner.csrf, key).send({ ...input, lines: [] }).expect(400);
    const cashier = await identity(cashierEmail);
    await post(cashier.cookie, cashier.csrf, randomUUID())
      .send({ ...input, clientOperationId: randomUUID() }).expect(403);
    expect((await pool.query('SELECT count(*)::integer AS n FROM purchases')).rows[0]?.n).toBe(1);
  });

  it('T162A exposes paid confirmation with idempotency, authorization and transfer without cash', async () => {
    const owner = await identity(ownerEmail);
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '1', unitCost: '8.00' }],
      payment: { method: 'TRANSFER', amount: '8.00' } };
    const post = (cookie: string, csrf: string, key: string) => request(app.getHttpServer())
      .post('/api/v1/purchases/paid').set('Origin', 'http://localhost:3000')
      .set('Cookie', cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf).set('Idempotency-Key', key);
    const key = randomUUID();
    const first = await post(owner.cookie, owner.csrf, key).send(input).expect(201);
    expect(first.body).toMatchObject({ id: input.clientOperationId, status: 'PAID', total: '8.00' });
    expect((await post(owner.cookie, owner.csrf, key).send(input).expect(201)).body).toEqual(first.body);
    await post(owner.cookie, owner.csrf, key).send({ ...input, payment: { method: 'TRANSFER', amount: '7.00' } }).expect(409);
    const cashier = await identity(cashierEmail);
    await post(cashier.cookie, cashier.csrf, randomUUID())
      .send({ ...input, clientOperationId: randomUUID() }).expect(403);
    expect((await pool.query('SELECT count(*)::integer AS n FROM purchase_payments WHERE purchase_id = $1',
      [first.body.id])).rows[0]?.n).toBe(1);
    expect((await pool.query("SELECT count(*)::integer AS n FROM cash_movements WHERE source_type = 'PURCHASE' AND source_id = $1",
      [first.body.id])).rows[0]?.n).toBe(0);
    const zero = { ...input, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '1', unitCost: '0.00' }] };
    const zeroResult = await post(owner.cookie, owner.csrf, randomUUID())
      .send({ branchId: zero.branchId, supplierId: zero.supplierId,
        clientOperationId: zero.clientOperationId, lines: zero.lines }).expect(201);
    expect(zeroResult.body).toMatchObject({ status: 'PAID', total: '0.00' });
    expect((await pool.query('SELECT count(*)::integer AS n FROM purchase_payments WHERE purchase_id = $1',
      [zero.clientOperationId])).rows[0]?.n).toBe(0);
  });

  it('T162B exposes exact payment of a pending purchase with replay and immutable status', async () => {
    const owner = await identity(ownerEmail);
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '1', unitCost: '9.00' }] };
    await request(app.getHttpServer()).post('/api/v1/purchases')
      .set('Origin', 'http://localhost:3000').set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', randomUUID()).send(input).expect(201);
    const post = (key: string) => request(app.getHttpServer())
      .post(`/api/v1/purchases/${input.clientOperationId}/pay`)
      .set('Origin', 'http://localhost:3000').set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', key);
    await post(randomUUID()).send({ method: 'TRANSFER', amount: '8.00' }).expect(400);
    const key = randomUUID();
    const payment = { method: 'TRANSFER', amount: '9.00' };
    const first = await post(key).send(payment).expect(201);
    expect(first.body).toMatchObject({ id: input.clientOperationId, status: 'PAID' });
    expect((await post(key).send(payment).expect(201)).body).toEqual(first.body);
    await post(randomUUID()).send(payment).expect(400);
    expect((await pool.query('SELECT confirmation_status FROM purchases WHERE id = $1',
      [input.clientOperationId])).rows[0]?.confirmation_status).toBe('PENDING_PAYMENT');
    expect((await pool.query('SELECT count(*)::integer AS n FROM purchase_payments WHERE purchase_id = $1',
      [input.clientOperationId])).rows[0]?.n).toBe(1);
  });

  it('T165 exposes one authorized cancellation with reason and idempotent replay', async () => {
    const owner = await identity(ownerEmail);
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '1', unitCost: '2.00' }] };
    await request(app.getHttpServer()).post('/api/v1/purchases')
      .set('Origin', 'http://localhost:3000').set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', randomUUID()).send(input).expect(201);
    const post = (cookie: string, csrf: string, key: string) => request(app.getHttpServer())
      .post(`/api/v1/purchases/${input.clientOperationId}/cancel`)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', key);
    const cashier = await identity(cashierEmail);
    await post(cashier.cookie, cashier.csrf, randomUUID()).send({ reason: 'Error' }).expect(403);
    await post(owner.cookie, owner.csrf, randomUUID()).send({ reason: ' ' }).expect(400);
    const key = randomUUID();
    const first = await post(owner.cookie, owner.csrf, key).send({ reason: 'Error' }).expect(201);
    expect(first.body).toMatchObject({ purchaseId: input.clientOperationId, status: 'CANCELLED' });
    expect((await post(owner.cookie, owner.csrf, key).send({ reason: 'Error' }).expect(201)).body)
      .toEqual(first.body);
    await post(owner.cookie, owner.csrf, randomUUID()).send({ reason: 'Otra vez' }).expect(409);
    const pay = await request(app.getHttpServer())
      .post(`/api/v1/purchases/${input.clientOperationId}/pay`)
      .set('Origin', 'http://localhost:3000').set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'TRANSFER', amount: '2.00' }).expect(400);
    expect(pay.body.code).toBe('PURCHASE_PAYMENT_INVALID');
  });

  it('T173C returns historical purchase state and rejects cashier reads', async () => {
    const owner = await identity(ownerEmail);
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '1', unitCost: '3.00' }] };
    await request(app.getHttpServer()).post('/api/v1/purchases')
      .set('Origin', 'http://localhost:3000').set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', randomUUID()).send(input).expect(201);
    const get = (cookie: string) => request(app.getHttpServer())
      .get(`/api/v1/purchases/${input.clientOperationId}`)
      .set('Cookie', cookie).set('X-Organization-Id', organizationId);
    expect((await get(owner.cookie).expect(200)).body).toMatchObject({ id: input.clientOperationId,
      status: 'PENDING_PAYMENT', total: '3.00', items: [{ itemName: 'Producto', unitCost: '3.00' }] });
    const cashier = await identity(cashierEmail);
    await get(cashier.cookie).expect(403);
  });
});
