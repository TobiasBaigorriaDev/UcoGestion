import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { CustomerAccountService } from '../src/modules/customers/customer-account.service.js';
import { SalesOperationsService } from '../src/modules/sales/sales-operations.service.js';
import { CustomerManagementService } from '../src/modules/customers/customer-management.service.js';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';

describe('customer accounts: real PostgreSQL, RLS and cash', () => {
  let container: StartedPostgreSqlContainer;
  let admin: Pool;
  let runtime: Pool;
  let transactions: TenantTransaction;
  let accounts: CustomerAccountService;
  let app: INestApplication;
  let previousUrl: string | undefined;
  const org = randomUUID(); const otherOrg = randomUUID(); const owner = randomUUID();
  const cashier = randomUUID(); const employee = randomUUID(); const membership = randomUUID();
  const branch = randomUUID(); const otherBranch = randomUUID();
  const device = randomUUID(); const session = randomUUID(); const otherSession = randomUUID();
  const otherDevice = randomUUID();
  const context = (userId = owner, organizationId = org) => ({ organizationId, userId, requestId: randomUUID() });
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    admin = new Pool({ connectionString: container.getConnectionUri() });
    await admin.query("CREATE ROLE account_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri()); url.username = 'account_runtime'; url.password = 'runtime-password';
    runtime = new Pool({ connectionString: url.toString() });
    transactions = new TenantTransaction(runtime); accounts = new CustomerAccountService(transactions);
    for (const [id, email] of [[owner, 'account-owner'], [cashier, 'account-cashier'], [employee, 'account-employee']]) {
      await admin.query("INSERT INTO users (id,email_normalized,password_hash,password_hash_version) VALUES ($1,$2,'$argon2id$v=19$fixture',1)", [id, `${email}@test.invalid`]);
    }
    await admin.query("INSERT INTO organizations (id,base_currency,timezone) VALUES ($1,'ARS','UTC'),($2,'ARS','UTC')", [org, otherOrg]);
    await admin.query("INSERT INTO memberships (id,organization_id,user_id,role) VALUES ($1,$2,$3,'OWNER'),($4,$2,$5,'CASHIER'),($6,$2,$7,'EMPLOYEE'),($8,$9,$3,'OWNER')",
      [randomUUID(), org, owner, membership, cashier, randomUUID(), employee, randomUUID(), otherOrg]);
    await admin.query("INSERT INTO branches (id,organization_id,name) VALUES ($1,$2,'Principal'),($3,$2,'Otra')", [branch, org, otherBranch]);
    await admin.query('INSERT INTO membership_branches (organization_id,membership_id,branch_id) VALUES ($1,$2,$3)', [org, membership, branch]);
    for (const [branchId, deviceId, sessionId] of [[branch, device, session], [otherBranch, otherDevice, otherSession]]) {
      const register = randomUUID();
      await admin.query("INSERT INTO cash_registers (id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Caja')", [register, org, branchId]);
      await admin.query("INSERT INTO devices (id,organization_id,branch_id,authorized_by_user_id,authorized_at,status) VALUES ($1,$2,$3,$4,now(),'ACTIVE')", [deviceId, org, branchId, owner]);
      await admin.query("INSERT INTO cash_sessions (id,organization_id,branch_id,cash_register_id,owner_user_id,device_id,origin,status,opening_cash,expected_cash,currency_code) VALUES ($1,$2,$3,$4,$5,$6,'ONLINE','OPEN','100.00','100.00','ARS')", [sessionId, org, branchId, register, cashier, deviceId]);
    }
    const actor = await createGlobalUser(admin, { email: 'accounts-http@test.invalid', password: 'correct-password' });
    await admin.query("INSERT INTO memberships (id,organization_id,user_id,role) VALUES ($1,$2,$3,'OWNER')", [randomUUID(), org, actor.id]);
    previousUrl = process.env.DATABASE_URL; process.env.DATABASE_URL = url.toString();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication()); await app.init();
  });
  afterAll(async () => {
    await app?.close(); await runtime?.end(); await admin?.end(); await container?.stop();
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
  });
  async function customer() {
    const id = randomUUID();
    await admin.query("INSERT INTO customers (id,organization_id,name) VALUES ($1,$2,'Cuenta de prueba')", [id, org]);
    return id;
  }
  async function charge(id: string, amount: string, elsewhere = false) {
    const saleId = randomUUID();
    const branchId = elsewhere ? otherBranch : branch;
    const cashSessionId = elsewhere ? otherSession : session;
    const deviceId = elsewhere ? otherDevice : device;
    return transactions.runWithOptionalAudit(context(), async client => {
      await accounts.prepareCharge(client, context(), id, amount);
      await client.query(`INSERT INTO sales (id,organization_id,branch_id,cash_session_id,device_id,customer_id,actor_user_id,session_owner_user_id,client_operation_id,currency_code,subtotal,discount,total,receipt_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$1,'ARS',$8,0,$8,'{}')`, [saleId, org, branchId, cashSessionId, deviceId, id, owner, amount]);
      await accounts.recordCharge(client, context(), { customerId: id, amount, saleId, branchId, cashSessionId, deviceId, currency: 'ARS' });
      return { result: saleId };
    });
  }
  const collect = (id: string, amount: string, method = 'CASH', key = randomUUID(), userId = owner) =>
    accounts.collect(context(userId), id, { cashSessionId: session, deviceId: device, amount, method }, key);

  it('starts at zero, versions limits, denies cashier edits and preserves cross-tenant privacy', async () => {
    const id = await customer();
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '0.00', creditLimit: '0.00', available: '0.00', version: 1, currency: 'ARS' });
    const limit = await accounts.setLimit(context(), id, 1, '50.00', randomUUID());
    expect(limit).toMatchObject({ creditLimit: '50.00', version: 2 });
    await expect(accounts.setLimit(context(), id, 2, '-1.00', randomUUID())).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_AMOUNT_INVALID' });
    await expect(accounts.setLimit(context(), id, 1, '60.00', randomUUID())).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(accounts.setLimit(context(cashier), id, 2, '60.00', randomUUID())).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_FORBIDDEN' });
    await expect(accounts.read(context(owner, otherOrg), id, {})).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_NOT_FOUND' });
    await expect(accounts.read(context(employee), id, {})).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_FORBIDDEN' });
    await expect(accounts.setLimit(context(owner, otherOrg), id, 2, '60.00', randomUUID())).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_NOT_FOUND' });
    await expect(collect(id, '1.00', 'CASH', randomUUID(), employee)).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_FORBIDDEN' });
    expect(await transactions.read(context(owner, otherOrg), async client => (await client.query('SELECT * FROM customer_accounts WHERE customer_id=$1', [id])).rowCount)).toBe(0);
  });

  it('cash collection is atomic and idempotent, while transfers do not affect cash', async () => {
    const id = await customer(); await accounts.setLimit(context(), id, 1, '100.00', randomUUID()); await charge(id, '60.00');
    const before = (await admin.query('SELECT expected_cash::text AS value FROM cash_sessions WHERE id=$1', [session])).rows[0]?.value;
    const key = randomUUID(); const first = await collect(id, '20.00', 'CASH', key, cashier);
    expect(await collect(id, '20.00', 'CASH', key, cashier)).toEqual(first);
    await expect(collect(id, '21.00', 'CASH', key, cashier)).rejects.toMatchObject({ name: 'IdempotencyKeyReusedError' });
    await collect(id, '10.00', 'TRANSFER');
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '30.00' });
    expect((await admin.query('SELECT expected_cash - $2::numeric AS added FROM cash_sessions WHERE id=$1', [session, before])).rows[0]?.added).toBe('20.00');
    expect((await admin.query("SELECT count(*)::int AS count FROM audit_events WHERE entity_id=$1 AND action='customer.account.collected'", [id])).rows[0]?.count).toBe(2);
    await expect(collect(id, '31.00')).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_AMOUNT_INVALID' });
    await expect(collect(id, '0.00')).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_AMOUNT_INVALID' });
    await expect(collect(id, '-1.00')).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_AMOUNT_INVALID' });
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '30.00' });
  });

  it('accepts the existing debit/credit card methods and preserves inactive customer collections', async () => {
    const id = await customer(); await accounts.setLimit(context(), id, 1, '50.00', randomUUID()); await charge(id, '30.00');
    await admin.query("UPDATE customers SET status='INACTIVE' WHERE id=$1", [id]);
    await collect(id, '5.00', 'DEBIT_CARD'); await collect(id, '5.00', 'CREDIT_CARD');
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '20.00' });
    await expect(charge(id, '1.00')).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_CUSTOMER_INACTIVE' });
    const customers = new CustomerManagementService(transactions);
    expect(await customers.findById(context(), id)).toMatchObject({ balance: '20.00', creditLimit: '50.00', currency: 'ARS' });
    await expect(customers.deletePhysically(context(), id, 1, randomUUID())).rejects.toMatchObject({ code: 'CUSTOMER_DELETE_BLOCKED_BY_HISTORY' });
    const unused = await customer(); await accounts.setLimit(context(), unused, 1, '0.00', randomUUID());
    expect(await customers.deletePhysically(context(), unused, 1, randomUUID())).toEqual({ id: unused, deleted: true });
  });

  it('rolls back account, cash, idempotency and history when audit insertion fails', async () => {
    const id = await customer(); await accounts.setLimit(context(), id, 1, '50.00', randomUUID()); await charge(id, '30.00');
    const before = (await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id=$1', [session])).rows[0]?.expected_cash;
    await admin.query(`CREATE FUNCTION test_reject_collection_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='customer.account.collected' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER test_reject_collection_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_reject_collection_audit()`);
    const key = randomUUID();
    try { await expect(collect(id, '5.00', 'CASH', key)).rejects.toThrow('audit unavailable'); }
    finally { await admin.query('DROP TRIGGER test_reject_collection_audit ON audit_events; DROP FUNCTION test_reject_collection_audit()'); }
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '30.00' });
    expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id=$1', [session])).rows[0]?.expected_cash).toBe(before);
    expect((await admin.query("SELECT 1 FROM customer_account_entries WHERE customer_id=$1 AND kind='COLLECTION'", [id])).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM idempotency_records WHERE organization_id=$1 AND key=$2', [org, key])).rowCount).toBe(0);
    await collect(id, '5.00', 'CASH', key);
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '25.00' });
  });

  it('serializes simultaneous collections, rolls back failures and refuses a limit below debt', async () => {
    const id = await customer(); await accounts.setLimit(context(), id, 1, '50.00', randomUUID()); await charge(id, '30.00');
    await expect(accounts.setLimit(context(), id, 3, '29.00', randomUUID())).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_LIMIT_BELOW_BALANCE' });
    const results = await Promise.allSettled([
      collect(id, '20.00'), accounts.collect(context(), id, { cashSessionId: otherSession, deviceId: otherDevice, amount: '20.00', method: 'TRANSFER' }, randomUUID()),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '10.00' });
    await admin.query("UPDATE payment_method_settings SET enabled=false WHERE organization_id=$1 AND method='QR'", [org]);
    await expect(collect(id, '1.00', 'QR')).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_PAYMENT_DISABLED' });
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '10.00' });
  });

  it('reverses a collection once with an immutable link, restores debt/cash and enforces branch scope', async () => {
    const id = await customer(); await accounts.setLimit(context(), id, 1, '100.00', randomUUID()); await charge(id, '40.00');
    const entry = await collect(id, '15.00');
    const input = { cashSessionId: session, deviceId: device, reason: 'Cobro equivocado' }; const key = randomUUID();
    await expect(accounts.reverseCollection(context(), id, entry.id, { ...input, cashSessionId: otherSession, deviceId: otherDevice }, randomUUID()))
      .rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_NOT_FOUND' });
    await expect(accounts.reverseCollection(context(cashier), id, entry.id, input, key)).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_FORBIDDEN' });
    const reversal = await accounts.reverseCollection(context(), id, entry.id, input, key);
    expect(await accounts.reverseCollection(context(), id, entry.id, input, key)).toEqual(reversal);
    await expect(accounts.reverseCollection(context(), id, entry.id, input, randomUUID())).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_ALREADY_REVERSED' });
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '40.00' });
    await charge(id, '10.00', true);
    const scoped = await accounts.read(context(cashier), id, {});
    expect(scoped.balance).toBe('50.00');
    expect(scoped.entries.every(entry => entry.branchId === branch)).toBe(true);
    await expect(accounts.collect(context(cashier), id, { cashSessionId: otherSession, deviceId: otherDevice, amount: '1.00', method: 'TRANSFER' }, randomUUID())).rejects.toMatchObject({ code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    await expect(admin.query("UPDATE customer_account_entries SET amount='1.00' WHERE id=$1", [entry.id])).rejects.toMatchObject({ code: '55000' });
    await expect(transactions.runWithOptionalAudit(context(), async client => ({ result: await client.query("UPDATE customer_accounts SET balance=0 WHERE customer_id=$1", [id]) }))).rejects.toMatchObject({ code: '42501' });
  });

  async function sale(id: string, onAccount = true, payments: { method: string; appliedAmount: string }[] = [], elsewhere = false) {
    const item = randomUUID();
    await admin.query("INSERT INTO catalog_items (id,organization_id,name,type,base_unit,price,price_version,track_inventory) VALUES ($1,$2,'Producto a cuenta','PRODUCT','UNIT','10.00',1,true)", [item, org]);
    const branchId = elsewhere ? otherBranch : branch;
    await admin.query('UPDATE branch_stocks SET quantity=5 WHERE organization_id=$1 AND branch_id=$2 AND item_id=$3', [org, branchId, item]);
    const sales = new SalesOperationsService(transactions);
    const lines = [{ itemId: item, quantity: '1' }];
    const quote = await sales.quote(context(), branchId, lines);
    const input = { branchId, cashSessionId: elsewhere ? otherSession : session, deviceId: elsewhere ? otherDevice : device,
      clientOperationId: randomUUID(), customerId: id, lines, payments, onAccount, quoteFingerprint: quote.quoteFingerprint };
    return { sales, input, item };
  }

  it('refuses a cash reversal without enough cash and rolls back the restored debt', async () => {
    const id = await customer(); await accounts.setLimit(context(), id, 1, '20.00', randomUUID()); await charge(id, '10.00');
    const entry = await collect(id, '5.00');
    const before = (await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id=$1', [session])).rows[0]?.expected_cash;
    const movement = (direction: 'IN' | 'OUT') => admin.query(`INSERT INTO cash_movements
      (id,organization_id,branch_id,cash_session_id,actor_user_id,device_id,delta,currency_code,source_type,source_id,effect_kind)
      VALUES ($1,$2,$3,$4,$5,$6,$7::numeric*$8,'ARS','TEST_WITHDRAWAL',$1,$9)`,
    [randomUUID(), org, branch, session, owner, device, before, direction === 'OUT' ? -1 : 1, direction]);
    await movement('OUT');
    try {
      await expect(accounts.reverseCollection(context(), id, entry.id,
        { cashSessionId: session, deviceId: device, reason: 'Error' }, randomUUID()))
        .rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_CASH_INSUFFICIENT' });
      expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '5.00' });
      expect((await admin.query("SELECT 1 FROM customer_account_entries WHERE original_entry_id=$1", [entry.id])).rowCount).toBe(0);
    } finally { await movement('IN'); }
  });

  it('cancels partial credit and refunds only the original cash payment', async () => {
    const id = await customer(); await accounts.setLimit(context(), id, 1, '20.00', randomUUID());
    const before = (await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id=$1', [session])).rows[0]?.expected_cash;
    const fixture = await sale(id, true, [{ method: 'CASH', appliedAmount: '4.00' }]);
    const confirmed = await fixture.sales.confirm(context(), fixture.input, randomUUID());
    await fixture.sales.cancel(context(), confirmed.id, { reason: 'Error', cashSessionId: session, deviceId: device }, randomUUID());
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '0.00' });
    expect((await admin.query('SELECT amount::text FROM sale_refunds WHERE sale_id=$1', [confirmed.id])).rows).toEqual([{ amount: '4.00' }]);
    expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id=$1', [session])).rows[0]?.expected_cash).toBe(before);
  });

  it('confirms partial and full credit sales, snapshots the debt and replays without effects', async () => {
    const id = await customer(); await accounts.setLimit(context(), id, 1, '30.00', randomUUID());
    const { sales, input, item } = await sale(id, true, [{ method: 'CASH', appliedAmount: '4.00' }]); const key = randomUUID();
    const first = await sales.confirm(context(), input, key);
    expect(first.receipt).toMatchObject({ paidAmount: '4.00', onAccountAmount: '6.00' });
    expect(await sales.confirm(context(), input, key)).toEqual(first);
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '6.00' });
    expect((await admin.query('SELECT quantity::text FROM branch_stocks WHERE branch_id=$1 AND item_id=$2', [branch, item])).rows[0]?.quantity).toBe('4.000');
    const second = await sale(id);
    await second.sales.confirm(context(), second.input, randomUUID());
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '16.00' });
    await expect(sales.confirm(context(), { ...input, onAccount: false, clientOperationId: randomUUID() }, randomUUID())).rejects.toMatchObject({ code: 'SALE_PAYMENTS_INVALID' });
    await expect(sales.confirm(context(), { ...input, customerId: null, clientOperationId: randomUUID() }, randomUUID())).rejects.toMatchObject({ code: 'SALE_CUSTOMER_NOT_AVAILABLE' });
  });

  it('serializes credit sales from two branches and never exceeds the global limit', async () => {
    const id = await customer(); await accounts.setLimit(context(), id, 1, '10.00', randomUUID());
    const first = await sale(id); const second = await sale(id, true, [], true);
    const results = await Promise.allSettled([first.sales.confirm(context(), first.input, randomUUID()), second.sales.confirm(context(), second.input, randomUUID())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '10.00' });
    const stocks = await admin.query('SELECT sum(quantity)::text AS quantity FROM branch_stocks WHERE item_id=ANY($1::uuid[])', [[first.item, second.item]]);
    expect(stocks.rows[0]?.quantity).toBe('9.000');
    const failed = results.find(result => result.status === 'rejected');
    expect(failed).toMatchObject({ status: 'rejected', reason: { code: 'CUSTOMER_ACCOUNT_LIMIT_EXCEEDED' } });
  });

  it('rolls back stock failures and compensates cancellation without inventing cash refunds', async () => {
    const id = await customer(); await accounts.setLimit(context(), id, 1, '20.00', randomUUID());
    const { sales, input, item } = await sale(id);
    await admin.query('UPDATE branch_stocks SET quantity=0 WHERE branch_id=$1 AND item_id=$2', [branch, item]);
    await expect(sales.confirm(context(), input, randomUUID())).rejects.toMatchObject({ code: 'SALE_STOCK_INSUFFICIENT' });
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '0.00', entries: [] });
    await admin.query('UPDATE branch_stocks SET quantity=5 WHERE branch_id=$1 AND item_id=$2', [branch, item]);
    const confirmed = await sales.confirm(context(), input, randomUUID());
    const collection = await collect(id, '10.00', 'TRANSFER');
    await expect(sales.cancel(context(), confirmed.id, { reason: 'Error' }, randomUUID())).rejects.toMatchObject({ code: 'CUSTOMER_ACCOUNT_CANCELLATION_REQUIRES_REVERSAL' });
    expect((await admin.query('SELECT 1 FROM sale_cancellations WHERE sale_id=$1', [confirmed.id])).rowCount).toBe(0);
    await accounts.reverseCollection(context(), id, collection.id, { cashSessionId: session, deviceId: device, reason: 'Reintegro previo a anular' }, randomUUID());
    const key = randomUUID(); const cancelled = await sales.cancel(context(), confirmed.id, { reason: 'Error' }, key);
    expect(await sales.cancel(context(), confirmed.id, { reason: 'Error' }, key)).toEqual(cancelled);
    expect(await accounts.read(context(), id, {})).toMatchObject({ balance: '0.00' });
    expect((await admin.query('SELECT quantity::text FROM branch_stocks WHERE branch_id=$1 AND item_id=$2', [branch, item])).rows[0]?.quantity).toBe('5.000');
    expect((await admin.query('SELECT 1 FROM sale_refunds WHERE sale_id=$1', [confirmed.id])).rowCount).toBe(0);
    expect((await admin.query("SELECT 1 FROM cash_movements WHERE source_id=$1 AND source_type='SALE'", [confirmed.id])).rowCount).toBe(0);
  });

  it('exposes real HTTP contracts, validates schemas/CSRF and preserves receipt and cursor data', async () => {
    const id = await customer();
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
      .send({ email: 'accounts-http@test.invalid', password: 'correct-password' }).expect(204);
    const rawCookies: unknown = login.headers['set-cookie'];
    const firstCookie = Array.isArray(rawCookies) ? rawCookies.find((value: unknown): value is string => typeof value === 'string')
      : typeof rawCookies === 'string' ? rawCookies : '';
    const cookie = firstCookie?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const base = `/api/v1/customers/${id}/account`;
    const get = (path: string) => request(app.getHttpServer()).get(path).set('Cookie', cookie).set('X-Organization-Id', org);
    const patch = (key: string) => request(app.getHttpServer()).patch(`${base}/limit`).set('Cookie', cookie)
      .set('X-Organization-Id', org).set('Origin', 'http://localhost:3000').set('X-CSRF-Token', String(csrf.body.csrfToken))
      .set('Idempotency-Key', key).set('If-Match', '1');
    const post = (path: string, key = randomUUID()) => request(app.getHttpServer()).post(path).set('Cookie', cookie)
      .set('X-Organization-Id', org).set('Origin', 'http://localhost:3000').set('X-CSRF-Token', String(csrf.body.csrfToken)).set('Idempotency-Key', key);
    expect((await get(base).expect(200)).body).toMatchObject({ balance: '0.00', creditLimit: '0.00', entries: [] });
    await patch(randomUUID()).send({ creditLimit: 50 }).expect(400);
    await patch(randomUUID()).send({ creditLimit: '50.00', balance: '999.00' }).expect(400);
    const key = randomUUID(); await patch(key).send({ creditLimit: '50.00' }).expect(200);
    await patch(key).send({ creditLimit: '50.00' }).expect(200);
    await patch(key).send({ creditLimit: '60.00' }).expect(409);
    const fixture = await sale(id, true, [{ method: 'CASH', appliedAmount: '4.00' }]);
    const confirmed = await post('/api/v1/sales').send(fixture.input).expect(201);
    expect(confirmed.body.receipt).toMatchObject({ paidAmount: '4.00', onAccountAmount: '6.00' });
    const printable = await get(`/api/v1/sales/${String(confirmed.body.id)}/receipt/print`).expect(200);
    expect(printable.text).toContain('A cuenta del cliente: 6.00 ARS');
    const collectionKey = randomUUID(); const payload = { cashSessionId: session, deviceId: device, amount: '2.00', method: 'DEBIT_CARD' };
    const collected = await post(`${base}/collections`, collectionKey).send(payload).expect(201);
    expect((await post(`${base}/collections`, collectionKey).send(payload).expect(201)).body).toEqual(collected.body);
    const page = await get(`${base}?limit=1&branchId=${branch}`).expect(200);
    expect(page.body).toMatchObject({ balance: '4.00', entries: [expect.objectContaining({ kind: 'COLLECTION' })], nextCursor: expect.any(String) });
    const next = await get(`${base}?limit=1&cursor=${encodeURIComponent(String(page.body.nextCursor))}`).expect(200);
    expect(next.body.entries[0]?.kind).toBe('SALE');
    const reversed = await post(`${base}/collections/${String(collected.body.id)}/reverse`).send({ cashSessionId: session, deviceId: device, reason: 'Cobro equivocado' }).expect(201);
    expect(reversed.body.balance).toBe('6.00');
    await request(app.getHttpServer()).post(`${base}/collections`).set('Cookie', cookie).set('X-Organization-Id', org)
      .set('Origin', 'http://localhost:3000').send(payload).expect(403);
    expect((await get(`/api/v1/customers/${id}`).expect(200)).body).toMatchObject({ balance: '6.00', creditLimit: '50.00', currency: 'ARS' });
  });
});
