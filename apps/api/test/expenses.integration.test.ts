import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { ExpensePersistence } from '../src/modules/expenses/expense-persistence.js';
import { ExpensePolicy } from '../src/modules/expenses/expense-policy.js';
import { ExpenseOperationsService } from '../src/modules/expenses/expense-operations.service.js';
import { ExpenseCancellationPreparation } from '../src/modules/expenses/expense-cancellation-preparation.js';

describe('T166–T170 expense creation', () => {
  let container: StartedPostgreSqlContainer;
  let admin: Pool;
  let runtime: Pool;
  const org = randomUUID(), foreignOrg = randomUUID();
  const owner = randomUUID(), administrator = randomUUID(), cashier = randomUUID(), employee = randomUUID();
  const adminMembership = randomUUID(), cashierMembership = randomUUID(), employeeMembership = randomUUID();
  const branch = randomUUID(), otherBranch = randomUUID(), foreignBranch = randomUUID();
  const category = randomUUID(), inactiveCategory = randomUUID(), foreignCategory = randomUUID();
  const register = randomUUID(), secondRegister = randomUUID();
  const device = randomUUID(), otherDevice = randomUUID(), session = randomUUID(), otherSession = randomUUID();
  const context = (userId: string = owner, organizationId: string = org) => ({ organizationId, userId, requestId: randomUUID() });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    admin = new Pool({ connectionString: container.getConnectionUri() });
    await admin.query("CREATE ROLE uco_expense_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri());
    url.username = 'uco_expense_runtime'; url.password = 'runtime-password';
    runtime = new Pool({ connectionString: url.toString() });
    for (const [id, email] of [[owner, 'owner'], [administrator, 'admin'], [cashier, 'cashier'], [employee, 'employee']] as const) {
      await admin.query('INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, $2, $3, 1)', [id, `expense-${email}@example.com`, '$argon2id$v=19$test']);
    }
    await admin.query("INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'UTC'), ($2, 'ARS', 'UTC')", [org, foreignOrg]);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'ADMIN'), ($6, $2, $7, 'CASHIER'), ($8, $2, $9, 'EMPLOYEE')", [randomUUID(), org, owner, adminMembership, administrator, cashierMembership, cashier, employeeMembership, employee]);
    await admin.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Principal'), ($3, $2, 'Otra'), ($4, $5, 'Ajena')", [branch, org, otherBranch, foreignBranch, foreignOrg]);
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3), ($1, $4, $3), ($1, $5, $3)', [org, adminMembership, branch, cashierMembership, employeeMembership]);
    await admin.query("INSERT INTO expense_categories (id, organization_id, name, status) VALUES ($1, $4, 'Servicios', 'ACTIVE'), ($2, $4, 'Inactiva', 'INACTIVE'), ($3, $5, 'Ajena', 'ACTIVE')", [category, inactiveCategory, foreignCategory, org, foreignOrg]);
    await admin.query("INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, 'Caja')", [register, org, branch]);
    for (const id of [device, otherDevice]) await admin.query("INSERT INTO devices (id, organization_id, branch_id, authorized_by_user_id, authorized_at, status) VALUES ($1, $2, $3, $4, now(), 'ACTIVE')", [id, org, branch, owner]);
    await admin.query("INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id, owner_user_id, device_id, origin, status, opening_cash, expected_cash, currency_code) VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', 100, 100, 'ARS')", [session, org, branch, register, cashier, device]);
    await admin.query("INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, 'Caja 2')", [secondRegister, org, branch]);
    await admin.query("INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id, owner_user_id, device_id, origin, status, opening_cash, expected_cash, currency_code) VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', 50, 50, 'ARS')", [otherSession, org, branch, secondRegister, owner, otherDevice]);
  });
  afterAll(async () => { await runtime?.end(); await admin?.end(); await container?.stop(); });

  it('T166 persists positive expense with active tenant category and immutable history', async () => {
    const tx = new TenantTransaction(runtime);
    const persistence = new ExpensePersistence();
    const persist = (categoryId: string, amount: string) => tx.runWithOptionalAudit(context(), async (client) => ({
      result: await persistence.persist(client, context(), { id: randomUUID(), branchId: branch, categoryId, concept: '  Luz  ', amount, method: 'TRANSFER' }),
    }));
    const created = await persist(category, '10.50');
    expect((await admin.query('SELECT concept, amount::text, actor_user_id, currency_code FROM expenses WHERE id = $1', [created.id])).rows[0])
      .toMatchObject({ concept: 'Luz', amount: '10.50', actor_user_id: owner, currency_code: 'ARS' });
    for (const id of [inactiveCategory, foreignCategory]) await expect(persist(id, '1.00')).rejects.toMatchObject({ code: id === inactiveCategory ? 'EXPENSE_CATEGORY_INACTIVE' : 'EXPENSE_CATEGORY_NOT_AVAILABLE' });
    for (const amount of ['0', '-1', '0.001']) await expect(persist(category, amount)).rejects.toThrow();
    expect((await admin.query('SELECT count(*)::integer AS n FROM expense_category_history_references WHERE source_id = $1', [created.id])).rows[0]?.n).toBe(1);
    expect(await tx.read(context(owner, foreignOrg), async (client) => (await client.query('SELECT id FROM expenses WHERE id = $1', [created.id])).rowCount)).toBe(0);
    await expect(admin.query("UPDATE expenses SET concept = 'Alterado' WHERE id = $1", [created.id])).rejects.toMatchObject({ code: '55000' });
  });

  it('T167–T169 applies role, branch, session and device policy', async () => {
    const tx = new TenantTransaction(runtime), policy = new ExpensePolicy();
    const authorize = (userId: string, branchId: string, method: string, sessionId?: string, deviceId?: string) =>
      tx.runWithOptionalAudit(context(userId), async (client) => ({ result: await policy.authorize(client, context(userId), { branchId, method, cashSessionId: sessionId, deviceId }) }));
    await expect(authorize(owner, otherBranch, 'TRANSFER')).resolves.toBe('OWNER');
    await expect(authorize(administrator, otherBranch, 'TRANSFER')).rejects.toMatchObject({ code: 'EXPENSE_FORBIDDEN' });
    await expect(authorize(administrator, branch, 'TRANSFER')).resolves.toBe('ADMIN');
    await expect(authorize(administrator, branch, 'CASH', session, device)).resolves.toBe('ADMIN');
    await expect(authorize(owner, branch, 'CASH', session, otherDevice)).rejects.toThrow();
    await expect(authorize(cashier, branch, 'CASH', session, device)).resolves.toBe('CASHIER');
    await expect(authorize(cashier, branch, 'CASH', otherSession, otherDevice)).rejects.toMatchObject({ code: 'EXPENSE_FORBIDDEN' });
    await expect(authorize(cashier, branch, 'TRANSFER')).rejects.toMatchObject({ code: 'EXPENSE_FORBIDDEN' });
    await expect(authorize(employee, branch, 'CASH', session, device)).rejects.toMatchObject({ code: 'EXPENSE_FORBIDDEN' });
  });

  it('T170 confirms cash and noncash atomically with replay, audit and cash limit', async () => {
    const service = new ExpenseOperationsService(new TenantTransaction(runtime));
    const cash = { branchId: branch, categoryId: category, concept: 'Insumos', amount: '15.00', method: 'CASH', cashSessionId: session, deviceId: device };
    const key = randomUUID();
    const first = await service.create(context(cashier), cash, key);
    expect(await service.create(context(cashier), cash, key)).toEqual(first);
    expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1', [session])).rows[0]?.expected_cash).toBe('85.00');
    expect((await admin.query("SELECT count(*)::integer AS n FROM cash_movements WHERE source_type = 'EXPENSE' AND source_id = $1", [first.id])).rows[0]?.n).toBe(1);
    expect((await admin.query("SELECT count(*)::integer AS n FROM audit_events WHERE entity_type = 'expense' AND entity_id = $1", [first.id])).rows[0]?.n).toBe(1);
    await expect(service.create(context(cashier), { ...cash, amount: '16.00' }, key)).rejects.toThrow();
    await expect(service.create(context(cashier), { ...cash, amount: '90.00' }, randomUUID())).rejects.toMatchObject({ code: 'CASH_INSUFFICIENT_EXPECTED' });
    expect((await admin.query("SELECT count(*)::integer AS n FROM expenses WHERE concept = 'Insumos'")).rows[0]?.n).toBe(1);
    const noncash = await service.create(context(administrator), { branchId: branch, categoryId: category, concept: 'Internet', amount: '7.25', method: 'TRANSFER' }, randomUUID());
    expect(noncash.method).toBe('TRANSFER');
    expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1', [session])).rows[0]?.expected_cash).toBe('85.00');
    await admin.query("UPDATE payment_method_settings SET enabled = false WHERE organization_id = $1 AND method = 'QR'", [org]);
    await expect(service.create(context(owner), { branchId: branch, categoryId: category, concept: 'QR', amount: '1.00', method: 'QR' }, randomUUID()))
      .rejects.toMatchObject({ code: 'EXPENSE_METHOD_NOT_AVAILABLE' });
  });

  it('T171 records one immutable cancellation with a reason without changing the expense', async () => {
    const service = new ExpenseOperationsService(new TenantTransaction(runtime));
    const expense = await service.create(context(), { branchId: branch, categoryId: category,
      concept: 'Gasto original', amount: '3.50', method: 'TRANSFER' }, randomUUID());
    const tx = new TenantTransaction(runtime), preparation = new ExpenseCancellationPreparation();
    await expect(tx.runWithOptionalAudit(context(), async (client) => ({ result:
      await preparation.prepare(client, context(), expense.id, '  ') })))
      .rejects.toMatchObject({ code: 'EXPENSE_CANCELLATION_REASON_REQUIRED' });
    const cancellation = await tx.runWithOptionalAudit(context(), async (client) => {
      const prepared = await preparation.prepare(client, context(), expense.id, '  Error de carga  ');
      await preparation.record(client, context(), prepared);
      return { result: prepared };
    });
    expect(cancellation.reason).toBe('Error de carga');
    expect((await admin.query('SELECT concept, amount::text FROM expenses WHERE id = $1', [expense.id])).rows[0])
      .toMatchObject({ concept: 'Gasto original', amount: '3.50' });
    await expect(tx.runWithOptionalAudit(context(), async (client) => ({ result:
      await preparation.prepare(client, context(), expense.id, 'Otra vez') })))
      .rejects.toMatchObject({ code: 'EXPENSE_ALREADY_CANCELLED' });
    await expect(admin.query('DELETE FROM expense_cancellations WHERE id = $1', [cancellation.id]))
      .rejects.toMatchObject({ code: '55000' });
  });

  it('T172 returns original cash in a valid session and device atomically', async () => {
    const service = new ExpenseOperationsService(new TenantTransaction(runtime));
    const expense = await service.create(context(owner), { branchId: branch, categoryId: category,
      concept: 'Efectivo a revertir', amount: '4.00', method: 'CASH', cashSessionId: session, deviceId: device }, randomUUID());
    const tx = new TenantTransaction(runtime), preparation = new ExpenseCancellationPreparation();
    const input = { cashSessionId: session, deviceId: device };
    await expect(tx.runWithOptionalAudit(context(), async (client) => ({ result:
      await preparation.requireCashReturnSession(client, context(), expense.id,
        { cashSessionId: session, deviceId: otherDevice }) }))).rejects.toThrow();
    await tx.runWithOptionalAudit(context(), async (client) => {
      const cash = await preparation.requireCashReturnSession(client, context(), expense.id, input);
      const prepared = await preparation.prepare(client, context(), expense.id, 'Error');
      await preparation.record(client, context(), prepared);
      if (!cash) throw new Error('Expected cash return');
      await preparation.recordCashReturn(client, context(), prepared, cash);
      return { result: prepared.id };
    });
    expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1', [session])).rows[0]?.expected_cash).toBe('85.00');
    expect((await admin.query("SELECT delta::text FROM cash_movements WHERE source_type = 'EXPENSE_CANCELLATION' AND source_id IN (SELECT id FROM expense_cancellations WHERE expense_id = $1)", [expense.id])).rows[0]?.delta).toBe('4.00');
  });

  it('T173 cancels noncash without touching cash and replays the audited result', async () => {
    const service = new ExpenseOperationsService(new TenantTransaction(runtime));
    const expense = await service.create(context(), { branchId: branch, categoryId: category,
      concept: 'Duplicado', amount: '6.00', method: 'TRANSFER' }, randomUUID());
    const before = (await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1', [session])).rows[0]?.expected_cash;
    const key = randomUUID();
    const first = await service.cancel(context(), expense.id, { reason: 'Duplicado' }, key);
    expect(await service.cancel(context(), expense.id, { reason: 'Duplicado' }, key)).toEqual(first);
    expect(first.status).toBe('CANCELLED');
    expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1', [session])).rows[0]?.expected_cash).toBe(before);
    expect((await admin.query('SELECT effect_kind FROM expense_cancellations WHERE expense_id = $1', [expense.id])).rows[0]?.effect_kind).toBe('NONCASH_REVERSAL');
    expect((await admin.query("SELECT count(*)::integer AS n FROM audit_events WHERE entity_type = 'expense' AND action = 'expense.cancelled' AND entity_id = $1", [expense.id])).rows[0]?.n).toBe(1);
    await expect(service.cancel(context(), expense.id, { reason: 'Otro' }, randomUUID()))
      .rejects.toMatchObject({ code: 'EXPENSE_ALREADY_CANCELLED' });
    await expect(service.cancel(context(cashier), expense.id, { reason: 'Otro' }, randomUUID()))
      .rejects.toMatchObject({ code: 'EXPENSE_CANCELLATION_FORBIDDEN' });
    await expect(service.cancel(context(owner, foreignOrg), expense.id, { reason: 'Ajeno' }, randomUUID()))
      .rejects.toMatchObject({ code: 'EXPENSE_CANCELLATION_NOT_AVAILABLE' });
    expect(await new TenantTransaction(runtime).read(context(owner, foreignOrg), async (client) =>
      (await client.query('SELECT id FROM expense_cancellations WHERE expense_id = $1', [expense.id])).rowCount)).toBe(0);
  });

  it('T173 rolls back cash cancellation on invalid device and commits one compensation', async () => {
    const service = new ExpenseOperationsService(new TenantTransaction(runtime));
    const expense = await service.create(context(), { branchId: branch, categoryId: category,
      concept: 'Efectivo', amount: '2.00', method: 'CASH', cashSessionId: session, deviceId: device }, randomUUID());
    const expected = (await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1', [session])).rows[0]?.expected_cash;
    await expect(service.cancel(context(), expense.id, { reason: 'Error', cashSessionId: session,
      deviceId: otherDevice }, randomUUID())).rejects.toThrow();
    expect((await admin.query('SELECT count(*)::integer AS n FROM expense_cancellations WHERE expense_id = $1', [expense.id])).rows[0]?.n).toBe(0);
    expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1', [session])).rows[0]?.expected_cash).toBe(expected);
    const first = await service.cancel(context(), expense.id, { reason: 'Error', cashSessionId: session,
      deviceId: device }, randomUUID());
    expect(first.status).toBe('CANCELLED');
    expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1', [session])).rows[0]?.expected_cash)
      .not.toBe(expected);
    expect((await admin.query("SELECT count(*)::integer AS n FROM cash_movements WHERE source_type = 'EXPENSE_CANCELLATION' AND source_id = $1", [first.id])).rows[0]?.n).toBe(1);
  });

  it('T173 rejects ADMIN cancellation outside assigned branch', async () => {
    const service = new ExpenseOperationsService(new TenantTransaction(runtime));
    const expense = await service.create(context(owner), { branchId: otherBranch,
      categoryId: category, concept: 'Otra sucursal', amount: '1.00', method: 'TRANSFER' }, randomUUID());
    await expect(service.cancel(context(administrator), expense.id, { reason: 'Fuera de alcance' }, randomUUID()))
      .rejects.toMatchObject({ code: 'EXPENSE_CANCELLATION_FORBIDDEN' });
    expect((await admin.query('SELECT count(*)::integer AS n FROM expense_cancellations WHERE expense_id = $1', [expense.id])).rows[0]?.n).toBe(0);
  });
});
