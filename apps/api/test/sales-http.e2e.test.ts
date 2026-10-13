import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import request from 'supertest';
import { pdfText } from './receipt-pdf-text.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { SaleCancellationPreparation } from '../src/modules/sales/sale-cancellation-preparation.js';
import { CustomerManagementService } from '../src/modules/customers/customer-management.service.js';

describe('T145 sales HTTP confirmation', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let previousUrl: string | undefined;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const branchId = randomUUID();
  const registerId = randomUUID();
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const itemId = randomUUID();
  const customerId = randomUUID();
  const email = 'sales-http-owner@example.com';
  const cashierMembershipId = randomUUID();
  let ownerId: string;
  let cashierId: string;
  let unscopedAdminId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const owner = await createGlobalUser(pool, { email, password: 'correct-password' });
    ownerId = owner.id;
    cashierId = (await createGlobalUser(pool, { email: 'sales-cashier@example.com',
      password: 'correct-password' })).id;
    unscopedAdminId = (await createGlobalUser(pool, { email: 'sales-unscoped-admin@example.com',
      password: 'correct-password' })).id;
    await pool.query("INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'Sales HTTP', 'ARS', 'UTC')", [organizationId]);
    await pool.query("INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'Other Sales', 'ARS', 'UTC')", [otherOrganizationId]);
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Principal')", [branchId, organizationId]);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [randomUUID(), organizationId, owner.id]);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [randomUUID(), otherOrganizationId, owner.id]);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'CASHIER')",
      [cashierMembershipId, organizationId, cashierId]);
    await pool.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationId, cashierMembershipId, branchId]);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'ADMIN')",
      [randomUUID(), organizationId, unscopedAdminId]);
    await pool.query("INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, 'Caja')",
      [registerId, organizationId, branchId]);
    await pool.query(`INSERT INTO devices (id, organization_id, branch_id, authorized_by_user_id, authorized_at, status)
      VALUES ($1, $2, $3, $4, now(), 'ACTIVE')`, [deviceId, organizationId, branchId, owner.id]);
    await pool.query(`INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id, owner_user_id,
      device_id, origin, status, opening_cash, expected_cash, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', '0.00', '0.00', 'ARS')`,
    [sessionId, organizationId, branchId, registerId, owner.id, deviceId]);
    await pool.query(`INSERT INTO catalog_items (id, organization_id, name, type, base_unit, price, price_version,
      track_inventory) VALUES ($1, $2, 'Producto', 'PRODUCT', 'UNIT', '10.00', 1, true)`,
    [itemId, organizationId]);
    await pool.query("UPDATE branch_stocks SET quantity = '2' WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3",
      [organizationId, branchId, itemId]);
    await pool.query("INSERT INTO customers (id, organization_id, name, status) VALUES ($1, $2, 'Comprador', 'ACTIVE')",
      [customerId, organizationId]);
    previousUrl = process.env.DATABASE_URL;
    await pool.query("CREATE ROLE sales_http_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'sales_http_runtime'; runtimeUrl.password = 'runtime-password';
    process.env.DATABASE_URL = runtimeUrl.toString();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close(); await pool?.end(); await container?.stop();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  it('confirms accepted price atomically and replays without duplicating effects', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3000').send({ email, password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const post = (path: string, key: string) => request(app.getHttpServer()).post(path)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', csrf.body.csrfToken as string)
      .set('Idempotency-Key', key);
    const checkoutContext = await request(app.getHttpServer())
      .get(`/api/v1/sales/checkout-context?branchId=${branchId}`)
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(checkoutContext.body).toMatchObject({ sessions: [{ id: sessionId, deviceId }],
      paymentMethods: expect.arrayContaining(['CASH', 'TRANSFER']) });
    const lines = [{ itemId, quantity: '1' }];
    const quoted = await post('/api/v1/sales/quote', 'quote-1').send({ branchId, lines }).expect(201);
    const sale = { branchId, cashSessionId: sessionId, deviceId, clientOperationId: randomUUID(),
      customerId,
      lines, quoteFingerprint: quoted.body.quoteFingerprint as string,
      payments: [{ method: 'CASH', appliedAmount: '5.00', receivedAmount: '10.00' },
        { method: 'TRANSFER', appliedAmount: '5.00' }] };
    await pool.query(`INSERT INTO catalog_price_versions (id, organization_id, item_id, price_version, price, currency)
      VALUES ($1, $2, $3, 2, '11.00', 'ARS')`, [randomUUID(), organizationId, itemId]);
    await pool.query("UPDATE catalog_items SET price = '11.00', price_version = price_version + 1, version = version + 1 WHERE id = $1", [itemId]);
    const changed = await post('/api/v1/sales', 'sale-stale').send(sale).expect(409);
    expect(changed.body).toMatchObject({ code: 'PRICE_CHANGED', currentTotal: '11.00' });
    expect((await pool.query('SELECT count(*)::integer AS count FROM sales')).rows[0]?.count).toBe(0);
    const accepted = { ...sale, quoteFingerprint: changed.body.quoteFingerprint as string,
      previousKey: 'sale-stale', acceptedPriceChange: true,
      payments: [{ method: 'CASH', appliedAmount: '6.00', receivedAmount: '10.00' },
        { method: 'TRANSFER', appliedAmount: '5.00' }] };
    for (const field of ['unitPrice', 'lineTotal', 'subtotal', 'discount', 'total', 'currencyCode', 'expectedCash', 'change']) {
      await post('/api/v1/sales', randomUUID()).send({ ...accepted, [field]: '0.01' }).expect(400);
    }
    for (const field of ['unitPrice', 'lineTotal', 'priceVersion']) {
      await post('/api/v1/sales', randomUUID()).send({ ...accepted,
        lines: accepted.lines.map(line => ({ ...line, [field]: '0.01' })) }).expect(400);
    }
    expect((await pool.query('SELECT count(*)::integer AS count FROM sales')).rows[0]?.count).toBe(0);
    const confirmed = await post('/api/v1/sales', 'sale-accepted').send(accepted).expect(201);
    expect(confirmed.body).toMatchObject({ id: sale.clientOperationId, total: '11.00',
      receipt: { label: 'Comprobante no fiscal', customer: { name: 'Comprador' } } });
    const saleDetails = await request(app.getHttpServer()).get(`/api/v1/sales/${sale.clientOperationId}`)
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(saleDetails.body).toMatchObject({ id: sale.clientOperationId, status: 'CONFIRMED',
      total: '11.00', items: [{ name: 'Producto' }],
      payments: expect.arrayContaining([{ method: 'CASH', amount: '6.00', change: '4.00' }]) });
    await request(app.getHttpServer()).post(`/api/v1/sales/${sale.clientOperationId}/cancel`)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie)
      .set('X-Organization-Id', otherOrganizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string)
      .set('Idempotency-Key', 'cross-tenant-cancel')
      .send({ reason: 'No debe acceder' }).expect(404);
    expect((await pool.query('SELECT count(*)::integer AS count FROM sale_cancellations WHERE sale_id = $1',
      [sale.clientOperationId])).rows[0]?.count).toBe(0);
    const cashierLogin = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3000').send({ email: 'sales-cashier@example.com',
        password: 'correct-password' }).expect(204);
    const cashierCookie = (cashierLogin.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    await request(app.getHttpServer()).get(`/api/v1/sales/${sale.clientOperationId}`)
      .set('Cookie', cashierCookie).set('X-Organization-Id', organizationId).expect(404);
    await request(app.getHttpServer()).get(`/api/v1/sales/${sale.clientOperationId}/receipt`)
      .set('Cookie', cashierCookie).set('X-Organization-Id', organizationId).expect(404);
    expect((await post('/api/v1/sales', 'sale-accepted').send(accepted).expect(201)).body)
      .toEqual(confirmed.body);
    expect((await pool.query('SELECT count(*)::integer AS count FROM sales WHERE id = $1',
      [sale.clientOperationId])).rows[0]?.count).toBe(1);
    expect((await pool.query('SELECT count(*)::integer AS count FROM inventory_movements WHERE source_id = $1',
      [sale.clientOperationId])).rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT delta::text FROM cash_movements WHERE source_type = 'SALE' AND source_id = $1",
      [sale.clientOperationId])).rows[0]?.delta).toBe('6.00');
    expect((await pool.query('SELECT count(*)::integer AS count FROM audit_events WHERE entity_id = $1',
      [sale.clientOperationId])).rows[0]?.count).toBe(1);
    await post('/api/v1/sales', 'sale-accepted').send({ ...accepted, payments: [] }).expect(409);
    await pool.query("UPDATE branch_stocks SET quantity = '0' WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3",
      [organizationId, branchId, itemId]);
    const rejected = await post('/api/v1/sales', 'sale-no-stock').send({ ...accepted,
      clientOperationId: randomUUID(), previousKey: undefined }).expect(409);
    expect(rejected.body).toMatchObject({ code: 'SALE_STOCK_INSUFFICIENT' });
    expect((await pool.query('SELECT count(*)::integer AS count FROM sales')).rows[0]?.count).toBe(1);
    expect((await pool.query('SELECT count(*)::integer AS count FROM sale_payments')).rows[0]?.count).toBe(2);
    expect((await pool.query("SELECT count(*)::integer AS count FROM audit_events WHERE action = 'sale.confirmed'"))
      .rows[0]?.count).toBe(1);

    const freeItemId = randomUUID();
    await pool.query(`INSERT INTO catalog_items (id, organization_id, name, type, base_unit, price, price_version,
      track_inventory) VALUES ($1, $2, 'Regalo', 'PRODUCT', 'UNIT', '0.00', 1, true)`,
    [freeItemId, organizationId]);
    await pool.query("UPDATE branch_stocks SET quantity = '1' WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3",
      [organizationId, branchId, freeItemId]);
    const freeLines = [{ itemId: freeItemId, quantity: '1' }];
    const freeQuote = await post('/api/v1/sales/quote', 'quote-free').send({ branchId, lines: freeLines }).expect(201);
    const freeSaleId = randomUUID();
    const freeSale = await post('/api/v1/sales', 'sale-free').send({ branchId, cashSessionId: sessionId,
      deviceId, clientOperationId: freeSaleId, lines: freeLines,
      quoteFingerprint: freeQuote.body.quoteFingerprint as string, payments: [] }).expect(201);
    expect(freeSale.body).toMatchObject({ id: freeSaleId, total: '0.00',
      receipt: { label: 'Comprobante no fiscal' } });
    expect((await pool.query('SELECT count(*)::integer AS count FROM sale_payments')).rows[0]?.count).toBe(2);
    expect((await pool.query('SELECT quantity::text FROM branch_stocks WHERE item_id = $1 AND branch_id = $2',
      [freeItemId, branchId])).rows[0]?.quantity).toBe('0.000');

    await pool.query("UPDATE organizations SET name = 'Nombre nuevo' WHERE id = $1", [organizationId]);
    await pool.query("UPDATE branches SET name = 'Sucursal nueva' WHERE id = $1", [branchId]);
    await pool.query("UPDATE customers SET name = 'Cliente nuevo' WHERE id = $1", [customerId]);
    await pool.query("UPDATE catalog_items SET name = 'Artículo nuevo' WHERE id = $1", [itemId]);
    const receipt = await request(app.getHttpServer()).get(`/api/v1/sales/${sale.clientOperationId}/receipt`)
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(receipt.body).toMatchObject({ saleId: sale.clientOperationId, label: 'Comprobante no fiscal',
      organization: { name: 'Sales HTTP' }, branch: { name: 'Principal' },
      customer: { name: 'Comprador' }, items: [{ name: 'Producto' }] });
    const printable = await request(app.getHttpServer())
      .get(`/api/v1/sales/${sale.clientOperationId}/receipt/print`)
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(printable.headers['content-type']).toContain('text/html');
    expect(printable.text).toContain('Comprobante no fiscal');
    expect(printable.text).toContain('Comprador');
    expect(printable.text).toContain(`ID de venta: ${receipt.body.saleCode}`);
    expect(printable.text).not.toContain('Cliente nuevo');
    const pdf = await request(app.getHttpServer()).get(`/api/v1/sales/${sale.clientOperationId}/receipt.pdf`)
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toBe(`attachment; filename="comprobante-${receipt.body.saleCode}.pdf"`);
    expect(pdf.headers['x-content-type-options']).toBe('nosniff');
    expect(Number(pdf.headers['content-length'])).toBe(pdf.body.length);
    expect(pdf.body.length).toBeGreaterThan(100);
    expect(await pdfText(pdf.body)).toContain(`ID de venta: ${receipt.body.saleCode}`);
    expect((await pool.query('SELECT receipt_snapshot FROM sales WHERE id=$1', [sale.clientOperationId]))
      .rows[0]?.receipt_snapshot).toEqual(confirmed.body.receipt);
    expect(printable.headers['x-content-type-options']).toBe('nosniff');
    expect(printable.text).not.toMatch(/<(?:script|iframe|object|embed)\b/i);
    for (const suffix of ['/receipt/print', '/receipt.pdf']) {
      await request(app.getHttpServer()).get(`/api/v1/sales/${sale.clientOperationId}${suffix}`)
        .set('Cookie', cookie).set('X-Organization-Id', otherOrganizationId).expect(404);
      await request(app.getHttpServer()).get(`/api/v1/sales/${sale.clientOperationId}${suffix}`)
        .set('X-Organization-Id', organizationId).expect(401);
    }
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await pool.query('SELECT count(*)::integer AS count FROM sales')).rows[0]?.count).toBe(2);
    await pool.query("UPDATE branch_stocks SET quantity = '1' WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3",
      [organizationId, branchId, itemId]);
    const nonCashQuote = await post('/api/v1/sales/quote', 'quote-non-cash')
      .send({ branchId, lines }).expect(201);
    const nonCashSaleId = randomUUID();
    await post('/api/v1/sales', 'sale-non-cash').send({ branchId, cashSessionId: sessionId,
      deviceId, clientOperationId: nonCashSaleId, lines,
      quoteFingerprint: nonCashQuote.body.quoteFingerprint as string,
      payments: [{ method: 'TRANSFER', appliedAmount: '11.00' }] }).expect(201);
    const cancellation = new SaleCancellationPreparation();
    const transaction = new TenantTransaction(pool);
    await expect(transaction.runWithOptionalAudit({ organizationId, userId: cashierId,
      requestId: randomUUID() }, async (client) => {
      await cancellation.prepare(client, { organizationId, userId: cashierId,
        requestId: randomUUID() }, sale.clientOperationId, 'Motivo válido');
      return { result: undefined };
    })).rejects.toMatchObject({ code: 'SALE_CANCELLATION_FORBIDDEN' });
    await expect(transaction.runWithOptionalAudit({ organizationId, userId: unscopedAdminId,
      requestId: randomUUID() }, async (client) => {
      await cancellation.prepare(client, { organizationId, userId: unscopedAdminId,
        requestId: randomUUID() }, sale.clientOperationId, 'Motivo válido');
      return { result: undefined };
    })).rejects.toMatchObject({ code: 'SALE_CANCELLATION_FORBIDDEN' });
    await expect(transaction.runWithOptionalAudit({ organizationId, userId: ownerId,
      requestId: randomUUID() }, async (client) => {
      await cancellation.prepare(client, { organizationId, userId: ownerId,
        requestId: randomUUID() }, sale.clientOperationId, '   ');
      return { result: undefined };
    })).rejects.toMatchObject({ code: 'SALE_CANCELLATION_REASON_REQUIRED' });
    await pool.query(`UPDATE payment_method_settings SET enabled = false
      WHERE organization_id = $1 AND method = 'TRANSFER'`, [organizationId]);
    const context = { organizationId, userId: ownerId, requestId: randomUUID() };
    const emptySession = await transaction.runWithOptionalAudit(context, async (client) => ({
      result: await cancellation.requireCashRefundSession(client, context, nonCashSaleId),
    }));
    expect(emptySession).toBeNull();
    const nonCashCancellation = await transaction.runWithOptionalAudit(context, async (client) => {
      const value = await cancellation.prepare(client, context, nonCashSaleId, 'Reintegro no efectivo');
      await cancellation.record(client, context, value);
      await cancellation.reverseStock(client, context, value);
      await cancellation.refund(client, context, value);
      return { result: value };
    });
    expect((await pool.query('SELECT method FROM sale_refunds WHERE cancellation_id = $1',
      [nonCashCancellation.cancellationId])).rows[0]?.method).toBe('TRANSFER');
    expect((await pool.query("SELECT count(*)::integer AS count FROM cash_movements WHERE source_type = 'SALE_CANCELLATION' AND source_id = $1",
      [nonCashCancellation.cancellationId])).rows[0]?.count).toBe(0);
    await pool.query(`INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id,
      actor_user_id, device_id, delta, currency_code, source_type, source_id, effect_kind)
      VALUES ($1, $2, $3, $4, $5, $6, '-6.00', 'ARS', 'TEST_USE', $7, 'OUT')`,
    [randomUUID(), organizationId, branchId, sessionId, ownerId, deviceId, randomUUID()]);
    await expect(transaction.runWithOptionalAudit(context, async (client) => ({
      result: await cancellation.requireCashRefundSession(client, context, sale.clientOperationId),
    }))).rejects.toMatchObject({ code: 'SALE_REFUND_SESSION_REQUIRED' });
    await expect(transaction.runWithOptionalAudit(context, async (client) => ({
      result: await cancellation.requireCashRefundSession(client, context,
        sale.clientOperationId, sessionId, randomUUID()),
    }))).rejects.toMatchObject({ code: 'CASH_SESSION_DEVICE_CONFLICT' });
    await expect(transaction.runWithOptionalAudit(context, async (client) => ({
      result: await cancellation.requireCashRefundSession(client, context,
        sale.clientOperationId, sessionId, deviceId),
    }))).rejects.toMatchObject({ code: 'SALE_REFUND_CASH_INSUFFICIENT' });
    expect((await pool.query('SELECT count(*)::integer AS count FROM sale_cancellations WHERE sale_id = $1',
      [sale.clientOperationId]))
      .rows[0]?.count).toBe(0);
    await pool.query(`INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id,
      actor_user_id, device_id, delta, currency_code, source_type, source_id, effect_kind)
      VALUES ($1, $2, $3, $4, $5, $6, '6.00', 'ARS', 'TEST_REPLENISH', $7, 'IN')`,
    [randomUUID(), organizationId, branchId, sessionId, ownerId, deviceId, randomUUID()]);
    const prepared = await transaction.runWithOptionalAudit(context, async (client) => {
      const cash = await cancellation.requireCashRefundSession(client, context,
        sale.clientOperationId, sessionId, deviceId);
      const value = await cancellation.prepare(client, context, sale.clientOperationId, '  Error de carga  ');
      await cancellation.record(client, context, value);
      await cancellation.reverseStock(client, context, value);
      await cancellation.refund(client, context, value);
      if (cash) await cancellation.recordCashRefund(client, context, value, cash);
      return { result: value };
    });
    expect((await pool.query('SELECT reason FROM sale_cancellations WHERE sale_id = $1',
      [sale.clientOperationId])).rows[0]?.reason).toBe('Error de carga');
    expect((await pool.query(`SELECT delta::text FROM inventory_movements
      WHERE source_type = 'SALE_CANCELLATION' AND source_id = $1`,
    [prepared.cancellationId])).rows[0]?.delta).toBe('1.000');
    expect((await pool.query(`SELECT method, amount::text FROM sale_refunds
      WHERE cancellation_id = $1 ORDER BY method`, [prepared.cancellationId])).rows)
      .toEqual([{ method: 'CASH', amount: '6.00' }, { method: 'TRANSFER', amount: '5.00' }]);
    expect((await pool.query(`SELECT delta::text FROM cash_movements
      WHERE source_type = 'SALE_CANCELLATION' AND source_id = $1`,
    [prepared.cancellationId])).rows[0]?.delta).toBe('-6.00');
    await expect(pool.query("UPDATE sale_cancellations SET reason = 'Otro' WHERE id = $1",
      [prepared.cancellationId])).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query("UPDATE sale_refunds SET amount = '1.00' WHERE cancellation_id = $1",
      [prepared.cancellationId])).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query('DELETE FROM sale_items WHERE sale_id = $1',
      [sale.clientOperationId])).rejects.toMatchObject({ code: '55000' });
    expect((await request(app.getHttpServer()).get(`/api/v1/sales/${sale.clientOperationId}/receipt`)
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200)).body)
      .toEqual(receipt.body);
    const historicalCustomer = (await pool.query<{ version: number }>('SELECT version::integer AS version FROM customers WHERE id=$1',
      [customerId])).rows[0];
    expect(historicalCustomer).toBeDefined();
    await expect(new CustomerManagementService(transaction).deletePhysically(context, customerId,
      historicalCustomer?.version ?? 0)).rejects.toMatchObject({ code: 'CUSTOMER_DELETE_BLOCKED_BY_HISTORY' });
    expect((await pool.query('SELECT id FROM customers WHERE id=$1', [customerId])).rows).toEqual([{ id: customerId }]);
    const isolated = await pool.connect();
    try {
      await isolated.query('BEGIN');
      await isolated.query('SET LOCAL ROLE uco_app');
      await isolated.query("SELECT set_config('app.organization_id', $1, true)", [randomUUID()]);
      expect((await isolated.query('SELECT count(*)::integer AS count FROM sale_cancellations'))
        .rows[0]?.count).toBe(0);
      expect((await isolated.query('SELECT count(*)::integer AS count FROM sale_refunds'))
        .rows[0]?.count).toBe(0);
    } finally {
      await isolated.query('ROLLBACK');
      isolated.release();
    }
    await expect(transaction.runWithOptionalAudit(context, async (client) => {
      const value = await cancellation.prepare(client, context, freeSaleId, 'Prueba de rollback');
      await cancellation.record(client, context, value);
      await cancellation.reverseStock(client, context, value);
      await cancellation.refund(client, context, value);
      throw new Error('simulated failure');
    })).rejects.toThrow('simulated failure');
    expect((await pool.query('SELECT count(*)::integer AS count FROM sale_cancellations WHERE sale_id = $1',
      [freeSaleId])).rows[0]?.count).toBe(0);
    expect((await pool.query('SELECT quantity::text FROM branch_stocks WHERE item_id = $1 AND branch_id = $2',
      [freeItemId, branchId])).rows[0]?.quantity).toBe('0.000');
    const cancellationStarted = new Date();
    const cancelled = await post(`/api/v1/sales/${freeSaleId}/cancel`, 'cancel-free')
      .send({ reason: '  Error de carga  ' }).expect(201);
    expect(cancelled.body).toMatchObject({ saleId: freeSaleId, status: 'CANCELLED' });
    expect((await post(`/api/v1/sales/${freeSaleId}/cancel`, 'cancel-free')
      .send({ reason: '  Error de carga  ' }).expect(201)).body).toEqual(cancelled.body);
    expect((await pool.query('SELECT reason FROM sale_cancellations WHERE sale_id = $1',
      [freeSaleId])).rows[0]?.reason).toBe('Error de carga');
    const cancellationMetadata = (await pool.query<{ actor_user_id: string; cancelled_at: Date }>(
      'SELECT actor_user_id,cancelled_at FROM sale_cancellations WHERE sale_id=$1', [freeSaleId])).rows[0];
    const authenticatedOwner = (await pool.query<{ id: string }>('SELECT id FROM users WHERE email_normalized=$1', [email])).rows[0];
    expect(cancellationMetadata?.actor_user_id).toBe(authenticatedOwner?.id);
    expect(cancellationMetadata?.cancelled_at.getTime()).toBeGreaterThanOrEqual(cancellationStarted.getTime());
    expect(cancellationMetadata?.cancelled_at.getTime()).toBeLessThanOrEqual(Date.now());
    const cancelledDetails = await request(app.getHttpServer()).get(`/api/v1/sales/${freeSaleId}`)
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(cancelledDetails.body).toMatchObject({ status: 'CANCELLED',
      cancellation: { reason: 'Error de carga' } });
    expect((await pool.query("SELECT count(*)::integer AS count FROM audit_events WHERE action = 'sale.cancelled' AND entity_id = $1",
      [freeSaleId])).rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory_movements WHERE source_type = 'SALE_CANCELLATION' AND source_id = $1",
      [cancelled.body.id])).rows[0]?.count).toBe(1);
    expect((await pool.query('SELECT quantity::text FROM branch_stocks WHERE item_id = $1 AND branch_id = $2',
      [freeItemId, branchId])).rows[0]?.quantity).toBe('1.000');
    await post(`/api/v1/sales/${freeSaleId}/cancel`, 'cancel-free')
      .send({ reason: 'Otro motivo' }).expect(409);
    await post(`/api/v1/sales/${freeSaleId}/cancel`, 'cancel-free-again')
      .send({ reason: 'Otro motivo' }).expect(409);
    const refundQuote = await post('/api/v1/sales/quote', 'quote-refund')
      .send({ branchId, lines }).expect(201);
    const refundSaleId = randomUUID();
    await post('/api/v1/sales', 'sale-refund').send({ branchId, cashSessionId: sessionId,
      deviceId, clientOperationId: refundSaleId, lines,
      quoteFingerprint: refundQuote.body.quoteFingerprint as string,
      payments: [{ method: 'CASH', appliedAmount: '11.00' }] }).expect(201);
    const beforeFailedRefund = (await pool.query('SELECT expected_cash::text AS amount FROM cash_sessions WHERE id = $1',
      [sessionId])).rows[0]?.amount;
    const missingSession = await post(`/api/v1/sales/${refundSaleId}/cancel`, 'cancel-refund-missing')
      .send({ reason: 'Error de cobro' }).expect(409);
    expect(missingSession.body).toMatchObject({ code: 'SALE_REFUND_SESSION_REQUIRED' });
    expect((await pool.query('SELECT count(*)::integer AS count FROM sale_cancellations WHERE sale_id = $1',
      [refundSaleId])).rows[0]?.count).toBe(0);
    expect((await pool.query('SELECT expected_cash::text AS amount FROM cash_sessions WHERE id = $1',
      [sessionId])).rows[0]?.amount).toBe(beforeFailedRefund);
    const cashCancelled = await post(`/api/v1/sales/${refundSaleId}/cancel`, 'cancel-refund')
      .send({ reason: 'Error de cobro', cashSessionId: sessionId, deviceId }).expect(201);
    expect((await pool.query("SELECT delta::text FROM cash_movements WHERE source_type = 'SALE_CANCELLATION' AND source_id = $1",
      [cashCancelled.body.id])).rows[0]?.delta).toBe('-11.00');
    expect((await pool.query('SELECT expected_cash::text AS amount FROM cash_sessions WHERE id = $1',
      [sessionId])).rows[0]?.amount).toBe('0.00');
    expect((await pool.query('SELECT amount::text FROM sale_refunds WHERE cancellation_id = $1',
      [cashCancelled.body.id])).rows[0]?.amount).toBe('11.00');
  });
  it('lists history with stable cursors, local dates, statuses and existing scope', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    for (const id of ids) await pool.query(`INSERT INTO sales
      (id, organization_id, branch_id, cash_session_id, device_id, actor_user_id,
       session_owner_user_id, client_operation_id, currency_code, subtotal, discount, total,
       receipt_snapshot, confirmed_at) VALUES ($1,$2,$3,$4,$5,$6,$6,$1,'ARS',0,0,0,'{}',
       '2025-01-02T02:30:00.123456Z')`, [id, organizationId, branchId, sessionId, deviceId, ownerId]);
    await pool.query(`INSERT INTO sale_cancellations
      (id,organization_id,sale_id,branch_id,actor_user_id,reason)
      VALUES ($1,$2,$3,$4,$5,'Prueba historial')`, [randomUUID(), organizationId, ids[1], branchId, ownerId]);
    await pool.query("UPDATE organizations SET timezone = 'America/Argentina/Buenos_Aires' WHERE id = $1", [organizationId]);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3000').send({ email, password: 'correct-password' }).expect(204);
    const cookies: unknown = login.headers['set-cookie'];
    const cookie = Array.isArray(cookies) && typeof cookies[0] === 'string' ? cookies[0].split(';')[0] ?? '' : '';
    const get = (query: string, tenant = organizationId, actorCookie = cookie) => request(app.getHttpServer())
      .get(`/api/v1/sales?branchId=${branchId}&${query}`).set('Cookie', actorCookie).set('X-Organization-Id', tenant);
    const first = await get('from=2025-01-01&to=2025-01-01&limit=2').expect(200);
    expect(first.body.items.map((row: { id: string }) => row.id)).toEqual(ids.slice(0, 2));
    expect(first.body.items).toMatchObject([{ status: 'CONFIRMED', total: '0.00', currency: 'ARS' }, { status: 'CANCELLED' }]);
    const second = await get(`from=2025-01-01&to=2025-01-01&limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`).expect(200);
    expect(second.body.items.map((row: { id: string }) => row.id)).toEqual(ids.slice(2));
    expect(second.body.nextCursor).toBeNull();
    expect((await get('from=2025-01-02&to=2025-01-02').expect(200)).body.items).toEqual([]);
    expect((await get('status=CANCELLED&from=2025-01-01&to=2025-01-01').expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([ids[1]]);
    expect((await get('', otherOrganizationId).expect(200)).body.items).toEqual([]);
    for (const actorEmail of ['sales-cashier@example.com', 'sales-unscoped-admin@example.com']) {
      const actor = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
        .send({ email: actorEmail, password: 'correct-password' }).expect(204);
      const actorCookies: unknown = actor.headers['set-cookie'];
      const actorCookie = Array.isArray(actorCookies) && typeof actorCookies[0] === 'string'
        ? actorCookies[0].split(';')[0] ?? '' : '';
      expect((await get('', organizationId, actorCookie).expect(200)).body.items).toEqual([]);
    }
    for (const invalid of ['status=DRAFT', 'from=2025-02-30', 'from=2025-02-01&to=2025-01-01',
      'limit=101', 'cursor=bad', 'unexpected=1']) await get(invalid).expect(400);
    await request(app.getHttpServer()).get(`/api/v1/sales?branchId=${branchId}`).expect(401);
  });
  it('groups authorized net sales by local day across selected branches', async () => {
    const secondBranch = randomUUID();
    await pool.query("INSERT INTO branches(id,organization_id,name) VALUES ($1,$2,'Secundaria')", [secondBranch, organizationId]);
    const secondRegister = randomUUID(), secondDevice = randomUUID(), secondSession = randomUUID();
    await pool.query("INSERT INTO cash_registers(id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Caja secundaria')", [secondRegister, organizationId, secondBranch]);
    await pool.query("INSERT INTO devices(id,organization_id,branch_id,authorized_by_user_id,authorized_at,status) VALUES ($1,$2,$3,$4,now(),'ACTIVE')", [secondDevice, organizationId, secondBranch, ownerId]);
    await pool.query("INSERT INTO cash_sessions(id,organization_id,branch_id,cash_register_id,owner_user_id,device_id,origin,status,opening_cash,expected_cash,currency_code) VALUES ($1,$2,$3,$4,$5,$6,'ONLINE','OPEN',0,0,'ARS')", [secondSession, organizationId, secondBranch, secondRegister, ownerId, secondDevice]);
    const firstSale = randomUUID(), secondSale = randomUUID(), cancelled = randomUUID();
    for (const [id, branch, session, device, total] of [
      [firstSale, branchId, sessionId, deviceId, '15.25'],
      [secondSale, secondBranch, secondSession, secondDevice, '9.75'],
      [cancelled, secondBranch, secondSession, secondDevice, '80.00'],
    ]) await pool.query(`INSERT INTO sales(id,organization_id,branch_id,cash_session_id,device_id,actor_user_id,session_owner_user_id,client_operation_id,currency_code,subtotal,discount,total,receipt_snapshot,confirmed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$1,'ARS',$7,0,$7,'{}','2024-12-29T02:30:00Z')`, [id, organizationId, branch, session, device, ownerId, total]);
    await pool.query("INSERT INTO sale_cancellations(id,organization_id,sale_id,branch_id,actor_user_id,reason) VALUES ($1,$2,$3,$4,$5,'Prueba')", [randomUUID(), organizationId, cancelled, secondBranch, ownerId]);
    await pool.query("UPDATE organizations SET timezone='America/Argentina/Buenos_Aires' WHERE id=$1", [organizationId]);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin','http://localhost:3000').send({ email, password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const get = (suffix: string, tenant = organizationId) => request(app.getHttpServer()).get(`/api/v1/sales/trends?from=2024-12-28&to=2024-12-30${suffix}`).set('Cookie',cookie).set('X-Organization-Id',tenant);
    expect((await get('').expect(200)).body.points).toEqual([
      { date: '2024-12-28', amount: '25.00', count: 2 },
      { date: '2024-12-29', amount: '0.00', count: 0 },
      { date: '2024-12-30', amount: '0.00', count: 0 },
    ]);
    expect((await get(`&branchId=${branchId}`).expect(200)).body.points[0]).toEqual({ date: '2024-12-28', amount: '15.25', count: 1 });
    const hourly = await request(app.getHttpServer())
      .get('/api/v1/sales/trends?from=2024-12-28&to=2024-12-28&groupBy=HOUR')
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(hourly.body.points).toHaveLength(24);
    expect(hourly.body.points[0]).toEqual({ date: '2024-12-28', hour: 0, amount: '0.00', count: 0 });
    expect(hourly.body.points[23]).toEqual({ date: '2024-12-28', hour: 23, amount: '25.00', count: 2 });
    const history = await request(app.getHttpServer())
      .get('/api/v1/sales?from=2024-12-28&to=2024-12-28')
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(history.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstSale, branchId }),
      expect.objectContaining({ id: secondSale, branchId: secondBranch }),
    ]));
    expect((await get('',otherOrganizationId).expect(200)).body.points[0]).toEqual({ date: '2024-12-28', amount: '0.00', count: 0 });
    const adminLogin = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin','http://localhost:3000').send({ email: 'sales-unscoped-admin@example.com', password: 'correct-password' }).expect(204);
    const adminCookie = (adminLogin.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    expect((await request(app.getHttpServer()).get('/api/v1/sales/trends?from=2024-12-28&to=2024-12-28')
      .set('Cookie', adminCookie).set('X-Organization-Id', organizationId).expect(200)).body.points[0])
      .toEqual({ date: '2024-12-28', amount: '0.00', count: 0 });
    for (const invalid of ['&from=2025-02-30', '&to=2025-02-01', '&branchId=bad']) await get(invalid).expect(400);
  });
  it('D03 protects detail and every receipt representation with real tenant, branch, role and session scope', async () => {
    const ownSession = randomUUID(), ownRegister = randomUUID(), ownSale = randomUUID(), foreignSessionSale = randomUUID();
    const scopedAdmin = await createGlobalUser(pool, { email: 'receipt-admin@example.com', password: 'correct-password' });
    const employee = await createGlobalUser(pool, { email: 'receipt-employee@example.com', password: 'correct-password' });
    const adminMembership = randomUUID(), employeeMembership = randomUUID();
    await pool.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,'ADMIN'),($4,$2,$5,'EMPLOYEE')",
      [adminMembership, organizationId, scopedAdmin.id, employeeMembership, employee.id]);
    await pool.query('INSERT INTO membership_branches(organization_id,membership_id,branch_id) VALUES ($1,$2,$3),($1,$4,$3)',
      [organizationId, adminMembership, branchId, employeeMembership]);
    await pool.query("INSERT INTO cash_registers(id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Caja del cajero')",
      [ownRegister, organizationId, branchId]);
    await pool.query(`INSERT INTO cash_sessions(id,organization_id,branch_id,cash_register_id,owner_user_id,device_id,
      origin,status,opening_cash,expected_cash,currency_code) VALUES ($1,$2,$3,$4,$5,$6,'ONLINE','OPEN',0,0,'ARS')`,
      [ownSession, organizationId, branchId, ownRegister, cashierId, deviceId]);
    const snapshot = { label: 'Comprobante no fiscal', total: '0.00', currency: 'ARS' };
    for (const value of [{ id: ownSale, session: ownSession, owner: cashierId },
      { id: foreignSessionSale, session: sessionId, owner: ownerId }]) {
      await pool.query(`INSERT INTO sales(id,organization_id,branch_id,cash_session_id,device_id,actor_user_id,
        session_owner_user_id,client_operation_id,currency_code,subtotal,discount,total,receipt_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$1,'ARS',0,0,0,$8::jsonb)`,
        [value.id, organizationId, branchId, value.session, deviceId, cashierId, value.owner, JSON.stringify(snapshot)]);
    }
    const loginCookie = async (loginEmail: string) => {
      const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
        .send({ email: loginEmail, password: 'correct-password' }).expect(204);
      const cookies: unknown = response.headers['set-cookie'];
      return Array.isArray(cookies) && typeof cookies[0] === 'string' ? cookies[0].split(';')[0] ?? '' : '';
    };
    const ownerCookie = await loginCookie(email), cashierCookie = await loginCookie('sales-cashier@example.com');
    const adminCookie = await loginCookie('receipt-admin@example.com'), employeeCookie = await loginCookie('receipt-employee@example.com');
    const unscopedCookie = await loginCookie('sales-unscoped-admin@example.com');
    for (const allowed of [ownerCookie, adminCookie, cashierCookie]) {
      const history = await request(app.getHttpServer()).get(`/api/v1/sales?branchId=${branchId}&limit=100`)
        .set('Cookie', allowed).set('X-Organization-Id', organizationId).expect(200);
      expect(history.body.items.map((row: { id: string }) => row.id)).toContain(ownSale);
      if (allowed === cashierCookie) expect(history.body.items.map((row: { id: string }) => row.id)).not.toContain(foreignSessionSale);
    }
    for (const denied of [employeeCookie, unscopedCookie]) {
      const history = await request(app.getHttpServer()).get(`/api/v1/sales?branchId=${branchId}`)
        .set('Cookie', denied).set('X-Organization-Id', organizationId).expect(200);
      expect(history.body.items).toEqual([]);
    }
    for (const suffix of ['', '/receipt', '/receipt/print', '/receipt.pdf']) {
      for (const allowed of [ownerCookie, adminCookie, cashierCookie]) {
        const result = await request(app.getHttpServer()).get(`/api/v1/sales/${ownSale}${suffix}`)
          .set('Cookie', allowed).set('X-Organization-Id', organizationId).expect(200);
        if (suffix === '/receipt') expect(result.body.saleId).toBe(ownSale);
      }
      for (const denied of [employeeCookie, unscopedCookie]) {
        const result = await request(app.getHttpServer()).get(`/api/v1/sales/${ownSale}${suffix}`)
          .set('Cookie', denied).set('X-Organization-Id', organizationId).expect(404);
        expect(JSON.stringify(result.body)).not.toContain('Comprobante no fiscal');
      }
      await request(app.getHttpServer()).get(`/api/v1/sales/${ownSale}${suffix}`)
        .set('Cookie', ownerCookie).set('X-Organization-Id', otherOrganizationId).expect(404);
      await request(app.getHttpServer()).get(`/api/v1/sales/${ownSale}${suffix}`)
        .set('X-Organization-Id', organizationId).expect(401);
      // Knowing an ID, or being the recorded actor, cannot grant another session's data.
      await request(app.getHttpServer()).get(`/api/v1/sales/${foreignSessionSale}${suffix}`)
        .set('Cookie', cashierCookie).set('X-Organization-Id', organizationId).expect(404);
    }
    await pool.query("UPDATE memberships SET status='REVOKED',revoked_at=now() WHERE id=$1", [cashierMembershipId]);
    await request(app.getHttpServer()).get(`/api/v1/sales?branchId=${branchId}`)
      .set('Cookie', cashierCookie).set('X-Organization-Id', organizationId).expect(403);
    for (const suffix of ['', '/receipt', '/receipt/print', '/receipt.pdf']) {
      await request(app.getHttpServer()).get(`/api/v1/sales/${ownSale}${suffix}`)
        .set('Cookie', cashierCookie).set('X-Organization-Id', organizationId).expect(403);
    }
    expect((await pool.query('SELECT receipt_snapshot FROM sales WHERE id=$1', [ownSale])).rows[0]?.receipt_snapshot).toEqual(snapshot);
  });



});
