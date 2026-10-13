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
    for (const field of ['branchId', 'supplierId', 'lines']) {
      const incomplete: Record<string, unknown> = { ...input };
      delete incomplete[field];
      await post(owner.cookie, owner.csrf, randomUUID()).send(incomplete).expect(400);
    }
    for (const field of ['itemId', 'quantity', 'unitCost']) {
      const incomplete: Record<string, unknown> = { ...input.lines[0] };
      delete incomplete[field];
      await post(owner.cookie, owner.csrf, randomUUID()).send({ ...input, lines: [incomplete] }).expect(400);
    }
    await post(owner.cookie, owner.csrf, randomUUID()).send({ ...input, lines: [] }).expect(400);
    for (const field of ['total', 'subtotal', 'currencyCode']) {
      await post(owner.cookie, owner.csrf, randomUUID()).send({ ...input, [field]: '0.01' }).expect(400);
    }
    await post(owner.cookie, owner.csrf, randomUUID()).send({ ...input,
      lines: [{ ...input.lines[0], lineTotal: '0.01' }] }).expect(400);
    expect((await pool.query('SELECT count(*)::integer AS n FROM purchases')).rows[0]?.n).toBe(0);
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

  it('RF-246 rejects negative and excess-scale unit costs without persisting effects', async () => {
    const owner = await identity(ownerEmail);
    for (const path of ['/api/v1/purchases', '/api/v1/purchases/paid']) {
      const operationId = randomUUID();
      const key = randomUUID();
      const post = () => request(app.getHttpServer()).post(path)
        .set('Origin', 'http://localhost:3000').set('Cookie', owner.cookie)
        .set('X-Organization-Id', organizationId).set('X-CSRF-Token', owner.csrf)
        .set('Idempotency-Key', key);
      for (const unitCost of ['10.005', '10.000', '-0.01']) {
        const rejected = await post().send({ branchId, supplierId, clientOperationId: operationId,
          lines: [{ itemId, quantity: '1', unitCost }] }).expect(400);
        expect(rejected.body.code).toBe('PURCHASE_LINE_INVALID');
      }
      expect((await pool.query('SELECT count(*)::integer AS n FROM purchases WHERE id = $1',
        [operationId])).rows[0]?.n).toBe(0);
      expect((await pool.query('SELECT count(*)::integer AS n FROM inventory_movements WHERE source_id = $1',
        [operationId])).rows[0]?.n).toBe(0);
      const input = { branchId, supplierId, clientOperationId: operationId,
        lines: [{ itemId, quantity: '1', unitCost: '0.00' }] };
      const first = await post().send(input).expect(201);
      expect(first.body.total).toBe('0.00');
      expect((await post().send(input).expect(201)).body).toEqual(first.body);
    }
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

  it('D07 lists historical products and net purchase trends with protected access', async () => {
    const owner = await identity(ownerEmail);
    const createdId = randomUUID();
    await request(app.getHttpServer()).post('/api/v1/purchases')
      .set('Origin', 'http://localhost:3000').set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', randomUUID()).send({ branchId, supplierId, clientOperationId: createdId,
        lines: [{ itemId, quantity: '2', unitCost: '7.25' }] }).expect(201);
    const today = new Date().toISOString().slice(0, 10);
    const history = await request(app.getHttpServer()).get('/api/v1/purchases')
      .query({ branchId, from: today, to: today, limit: 25 })
      .set('Cookie', owner.cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(history.body.items).toContainEqual(expect.objectContaining({ id: createdId,
      status: 'PENDING_PAYMENT', supplierName: 'Proveedor', total: '14.50',
      items: [expect.objectContaining({ itemName: 'Producto', quantity: '2.000', lineTotal: '14.50' })] }));
    const paidId = randomUUID();
    await request(app.getHttpServer()).post('/api/v1/purchases')
      .set('Origin', 'http://localhost:3000').set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', randomUUID()).send({ branchId, supplierId, clientOperationId: paidId,
        lines: [{ itemId, quantity: '1', unitCost: '1.00' }] }).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/purchases/${paidId}/pay`)
      .set('Origin', 'http://localhost:3000').set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', randomUUID()).send({ method: 'TRANSFER', amount: '1.00' }).expect(201);
    const paidPage = await request(app.getHttpServer()).get('/api/v1/purchases')
      .query({ branchId, status: 'PAID' }).set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId).expect(200);
    expect(paidPage.body.items).toContainEqual(expect.objectContaining({ id: paidId, status: 'PAID' }));
    const pageOne = await request(app.getHttpServer()).get('/api/v1/purchases')
      .query({ branchId, limit: 1 }).set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId).expect(200);
    expect(pageOne.body.items).toHaveLength(1);
    expect(pageOne.body.nextCursor).toEqual(expect.any(String));
    const pageTwo = await request(app.getHttpServer()).get('/api/v1/purchases')
      .query({ branchId, limit: 1, cursor: pageOne.body.nextCursor })
      .set('Cookie', owner.cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(pageTwo.body.items).toHaveLength(1);
    expect(pageTwo.body.items[0].id).not.toBe(pageOne.body.items[0].id);
    await request(app.getHttpServer()).get('/api/v1/purchases')
      .query({ from: today, to: '2024-01-01' }).set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId).expect(400);
    const trends = await request(app.getHttpServer()).get('/api/v1/purchases/trends')
      .query({ branchId, from: today, to: today, groupBy: 'HOUR' })
      .set('Cookie', owner.cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(trends.body.points).toHaveLength(24);
    const confirmed = history.body.items.find((item: { id: string }) => item.id === createdId);
    const hour = new Date(confirmed.confirmedAt).getUTCHours();
    const before = trends.body.points.find((point: { hour: number }) => point.hour === hour);
    expect(before?.count).toBeGreaterThan(0);
    expect(trends.body.points.some((point: { amount: string }) => point.amount === '0.00')).toBe(true);
    const otherBranch = randomUUID();
    const admin = await createGlobalUser(pool, { email: `purchase-history-admin-${randomUUID()}@example.com`,
      password: 'correct-password' });
    const adminMembership = randomUUID();
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Otro local')",
      [otherBranch, organizationId]);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'ADMIN')",
      [adminMembership, organizationId, admin.id]);
    await pool.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationId, adminMembership, otherBranch]);
    const scoped = await identity(admin.email);
    const scopedHistory = await request(app.getHttpServer()).get('/api/v1/purchases')
      .set('Cookie', scoped.cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(scopedHistory.body.items).not.toContainEqual(expect.objectContaining({ id: createdId }));
    const scopedTrends = await request(app.getHttpServer()).get('/api/v1/purchases/trends')
      .query({ from: today, to: today, groupBy: 'HOUR' }).set('Cookie', scoped.cookie)
      .set('X-Organization-Id', organizationId).expect(200);
    expect(scopedTrends.body.points.every((point: { count: number }) => point.count === 0)).toBe(true);
    const isolatedOrganization = randomUUID();
    await pool.query("INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'Otro tenant', 'ARS', 'UTC')",
      [isolatedOrganization]);
    const ownerUser = await pool.query<{ id: string }>('SELECT user_id AS id FROM memberships WHERE organization_id = $1 AND role = $2',
      [organizationId, 'OWNER']);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [randomUUID(), isolatedOrganization, ownerUser.rows[0]?.id]);
    const isolated = await request(app.getHttpServer()).get('/api/v1/purchases')
      .set('Cookie', owner.cookie).set('X-Organization-Id', isolatedOrganization).expect(200);
    expect(isolated.body.items).toEqual([]);
    const isolatedTrends = await request(app.getHttpServer()).get('/api/v1/purchases/trends')
      .query({ from: today, to: today, groupBy: 'HOUR' }).set('Cookie', owner.cookie)
      .set('X-Organization-Id', isolatedOrganization).expect(200);
    expect(isolatedTrends.body.points.every((point: { count: number }) => point.count === 0)).toBe(true);
    await request(app.getHttpServer()).post(`/api/v1/purchases/${createdId}/cancel`)
      .set('Origin', 'http://localhost:3000').set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', owner.csrf)
      .set('Idempotency-Key', randomUUID()).send({ reason: 'Prueba de historial' }).expect(201);
    const cancelled = await request(app.getHttpServer()).get('/api/v1/purchases')
      .query({ branchId, from: today, to: today, status: 'CANCELLED' })
      .set('Cookie', owner.cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(cancelled.body.items).toContainEqual(expect.objectContaining({ id: createdId, status: 'CANCELLED' }));
    const afterTrends = await request(app.getHttpServer()).get('/api/v1/purchases/trends')
      .query({ branchId, from: today, to: today, groupBy: 'HOUR' })
      .set('Cookie', owner.cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(afterTrends.body.points.find((point: { hour: number }) => point.hour === hour)?.count)
      .toBe(before.count - 1);
    const cashier = await identity(cashierEmail);
    await request(app.getHttpServer()).get('/api/v1/purchases')
      .set('Cookie', cashier.cookie).set('X-Organization-Id', organizationId).expect(403);
    await request(app.getHttpServer()).get('/api/v1/purchases/trends')
      .query({ from: today, to: today }).set('Cookie', cashier.cookie)
      .set('X-Organization-Id', organizationId).expect(403);
    const localId = randomUUID();
    await pool.query("UPDATE organizations SET timezone = 'America/Argentina/Buenos_Aires' WHERE id = $1",
      [organizationId]);
    await pool.query(`INSERT INTO purchases(id,organization_id,branch_id,supplier_id,actor_user_id,
      client_operation_id,confirmation_status,currency_code,total,supplier_snapshot,confirmed_at)
      VALUES ($1,$2,$3,$4,$5,$1,'PENDING_PAYMENT','ARS','9.00',$6::jsonb,'2026-04-01T01:30:00Z')`,
    [localId, organizationId, branchId, supplierId, ownerUser.rows[0]?.id,
      JSON.stringify({ name: 'Proveedor' })]);
    const localPage = await request(app.getHttpServer()).get('/api/v1/purchases')
      .query({ branchId, from: '2026-03-31', to: '2026-03-31' })
      .set('Cookie', owner.cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(localPage.body.items).toContainEqual(expect.objectContaining({ id: localId }));
    const localTrends = await request(app.getHttpServer()).get('/api/v1/purchases/trends')
      .query({ branchId, from: '2026-03-31', to: '2026-03-31', groupBy: 'DAY' })
      .set('Cookie', owner.cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(localTrends.body.points).toContainEqual({ date: '2026-03-31', amount: '9.00', count: 1 });
  });
});
