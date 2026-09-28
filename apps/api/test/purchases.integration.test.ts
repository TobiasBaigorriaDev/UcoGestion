import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { PurchasePersistence } from '../src/modules/purchases/purchase-persistence.js';
import { PurchasePolicy, type PurchaseAction } from '../src/modules/purchases/purchase-policy.js';
import { PurchaseOperationsService } from '../src/modules/purchases/purchase-operations.service.js';
import { PurchaseCancellationPreparation } from '../src/modules/purchases/purchase-cancellation-preparation.js';
import { DeviceAuthorizationService } from '../src/modules/cash/device-authorization.service.js';

describe('purchase foundation', () => {
  let container: StartedPostgreSqlContainer;
  let admin: Pool;
  let runtime: Pool;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const adminMembershipId = randomUUID();
  const employeeId = randomUUID();
  const employeeMembershipId = randomUUID();
  const cashierId = randomUUID();
  const cashierMembershipId = randomUUID();
  const branchId = randomUUID();
  const otherBranchId = randomUUID();
  const supplierId = randomUUID();
  const inactiveSupplierId = randomUUID();
  const foreignSupplierId = randomUUID();
  const itemId = randomUUID();
  const context = (organization: string = organizationId, userId: string = ownerId) =>
    ({ organizationId: organization, userId, requestId: randomUUID() });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    admin = new Pool({ connectionString: container.getConnectionUri() });
    await admin.query("CREATE ROLE uco_purchase_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri());
    url.username = 'uco_purchase_runtime'; url.password = 'runtime-password';
    runtime = new Pool({ connectionString: url.toString() });
    await admin.query("INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, 'purchase-owner@example.com', '$argon2id$v=19$owner', 1)", [ownerId]);
    await admin.query("INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, 'purchase-admin@example.com', '$argon2id$v=19$admin', 1)", [adminId]);
    await admin.query("INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, 'purchase-employee@example.com', '$argon2id$v=19$employee', 1)", [employeeId]);
    await admin.query("INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, 'purchase-cashier@example.com', '$argon2id$v=19$cashier', 1)", [cashierId]);
    await admin.query("INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'UTC'), ($2, 'USD', 'UTC')", [organizationId, otherOrganizationId]);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')", [randomUUID(), organizationId, ownerId]);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'ADMIN')", [adminMembershipId, organizationId, adminId]);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'EMPLOYEE')", [employeeMembershipId, organizationId, employeeId]);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'CASHIER')", [cashierMembershipId, organizationId, cashierId]);
    await admin.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Local')", [branchId, organizationId]);
    await admin.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Otro')", [otherBranchId, organizationId]);
    await admin.query("INSERT INTO suppliers (id, organization_id, name, status) VALUES ($1, $4, 'Activo', 'ACTIVE'), ($2, $4, 'Inactivo', 'INACTIVE'), ($3, $5, 'Ajeno', 'ACTIVE')", [supplierId, inactiveSupplierId, foreignSupplierId, organizationId, otherOrganizationId]);
    await admin.query("INSERT INTO catalog_items (id, organization_id, name, type, track_inventory, base_unit, price, price_version) VALUES ($1, $2, 'Producto', 'PRODUCT', true, 'UNIT', '2.00', 1)", [itemId, organizationId]);
  });
  afterAll(async () => { await runtime?.end(); await admin?.end(); await container?.stop(); });

  it('T153 persists an immutable pending purchase with supplier and item snapshots under tenant RLS', async () => {
    const transactions = new TenantTransaction(runtime);
    const id = randomUUID();
    const input = { id, branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '2', unitCost: '3.25' }] };
    await transactions.runWithOptionalAudit(context(), async (client) => ({
      result: await new PurchasePersistence().persistPending(client, context(), input),
    }));
    expect((await admin.query('SELECT confirmation_status, total::text, supplier_snapshot FROM purchases WHERE id = $1', [id])).rows[0])
      .toMatchObject({ confirmation_status: 'PENDING_PAYMENT', total: '6.50', supplier_snapshot: { name: 'Activo' } });
    expect((await admin.query('SELECT item_name, quantity::text, unit_cost::text, line_total::text, currency_code FROM purchase_items WHERE purchase_id = $1', [id])).rows[0])
      .toMatchObject({ item_name: 'Producto', quantity: '2.000', unit_cost: '3.25', line_total: '6.50', currency_code: 'ARS' });
    expect(await transactions.read(context(otherOrganizationId), async (client) =>
      (await client.query('SELECT id FROM purchases WHERE id = $1', [id])).rowCount)).toBe(0);
    await expect(admin.query('UPDATE purchase_items SET item_name = $1 WHERE purchase_id = $2', ['changed', id]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(admin.query('UPDATE purchases SET total = 0 WHERE id = $1', [id]))
      .rejects.toMatchObject({ code: '55000' });
    for (const selectedSupplierId of [inactiveSupplierId, foreignSupplierId]) {
      await expect(transactions.runWithOptionalAudit(context(), async (client) => ({
        result: await new PurchasePersistence().persistPending(client, context(),
          { ...input, id: randomUUID(), supplierId: selectedSupplierId, clientOperationId: randomUUID() }),
      }))).rejects.toMatchObject({ code: 'PURCHASE_SUPPLIER_NOT_AVAILABLE' });
    }
  });

  it('T154 permits OWNER in any branch and ADMIN only in assigned branches', async () => {
    const transactions = new TenantTransaction(runtime);
    const policy = new PurchasePolicy();
    const check = (userId: string, selectedBranchId: string) => transactions.read(
      context(organizationId, userId), (client) => policy.authorize(client,
        context(organizationId, userId), selectedBranchId, 'CONFIRM_PENDING'));
    await expect(check(ownerId, branchId)).resolves.toBe('OWNER');
    await expect(check(ownerId, otherBranchId)).resolves.toBe('OWNER');
    await expect(check(adminId, branchId)).rejects.toMatchObject({ code: 'PURCHASE_FORBIDDEN' });
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationId, adminMembershipId, branchId]);
    await expect(check(adminId, branchId)).resolves.toBe('ADMIN');
    await expect(check(adminId, otherBranchId)).rejects.toMatchObject({ code: 'PURCHASE_FORBIDDEN' });
  });

  it('T155 allows EMPLOYEE to receive pending in assigned branch only', async () => {
    const transactions = new TenantTransaction(runtime);
    const policy = new PurchasePolicy();
    const check = (selectedBranchId: string) => transactions.read(context(organizationId, employeeId),
      (client) => policy.authorize(client, context(organizationId, employeeId),
        selectedBranchId, 'CONFIRM_PENDING'));
    await expect(check(branchId)).rejects.toMatchObject({ code: 'PURCHASE_FORBIDDEN' });
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationId, employeeMembershipId, branchId]);
    await expect(check(branchId)).resolves.toBe('EMPLOYEE');
    await expect(check(otherBranchId)).rejects.toMatchObject({ code: 'PURCHASE_FORBIDDEN' });
  });

  it('T156 rejects every purchase action for CASHIER even with branch scope', async () => {
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationId, cashierMembershipId, branchId]);
    const transactions = new TenantTransaction(runtime);
    const policy = new PurchasePolicy();
    for (const action of ['CREATE', 'CONFIRM_PENDING', 'CONFIRM_PAID', 'PAY', 'CANCEL'] as const satisfies readonly PurchaseAction[]) {
      await expect(transactions.read(context(organizationId, cashierId), (client) =>
        policy.authorize(client, context(organizationId, cashierId), branchId, action)))
        .rejects.toMatchObject({ code: 'PURCHASE_FORBIDDEN' });
    }
  });

  it('T157 confirms pending atomically with stock, ledger, audit and idempotency', async () => {
    const purchases = new PurchaseOperationsService(new TenantTransaction(runtime));
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '2', unitCost: '3.25' }] };
    const key = randomUUID();
    const first = await purchases.confirmPending(context(organizationId, employeeId), input, key);
    expect(first).toMatchObject({ id: input.clientOperationId, total: '6.50', status: 'PENDING_PAYMENT' });
    expect(await purchases.confirmPending(context(organizationId, employeeId), input, key)).toEqual(first);
    expect((await admin.query('SELECT count(*)::integer AS n FROM purchases WHERE id = $1', [first.id])).rows[0]?.n).toBe(1);
    expect((await admin.query("SELECT count(*)::integer AS n FROM inventory_movements WHERE source_type = 'PURCHASE' AND source_id = $1", [first.id])).rows[0]?.n).toBe(1);
    expect((await admin.query('SELECT quantity::text FROM branch_stocks WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3',
      [organizationId, branchId, itemId])).rows[0]?.quantity).toBe('2.000');
    expect((await admin.query("SELECT count(*)::integer AS n FROM cash_movements WHERE source_type = 'PURCHASE' AND source_id = $1", [first.id])).rows[0]?.n).toBe(0);
    expect((await admin.query("SELECT count(*)::integer AS n FROM audit_events WHERE organization_id = $1 AND entity_id = $2 AND action = 'purchase.confirmed'", [organizationId, first.id])).rows[0]?.n).toBe(1);
    const concurrentInput = { ...input, clientOperationId: randomUUID() };
    const concurrentKey = randomUUID();
    const concurrent = await Promise.all([1, 2].map(() => purchases.confirmPending(
      context(organizationId, employeeId), concurrentInput, concurrentKey)));
    expect(concurrent[0]).toEqual(concurrent[1]);
    expect((await admin.query('SELECT count(*)::integer AS n FROM purchases WHERE id = $1',
      [concurrentInput.clientOperationId])).rows[0]?.n).toBe(1);
    expect((await admin.query("SELECT count(*)::integer AS n FROM inventory_movements WHERE source_type = 'PURCHASE' AND source_id = $1",
      [concurrentInput.clientOperationId])).rows[0]?.n).toBe(1);
    await expect(purchases.confirmPending(context(organizationId, employeeId),
      { ...input, lines: [{ itemId, quantity: '3', unitCost: '3.25' }] }, key))
      .rejects.toThrow();
    const before = (await admin.query("SELECT count(*)::integer AS n FROM purchases WHERE organization_id = $1", [organizationId])).rows[0]?.n;
    await expect(purchases.confirmPending(context(organizationId, employeeId),
      { ...input, supplierId: inactiveSupplierId, clientOperationId: randomUUID() }, randomUUID()))
      .rejects.toMatchObject({ code: 'PURCHASE_SUPPLIER_NOT_AVAILABLE' });
    expect((await admin.query("SELECT count(*)::integer AS n FROM purchases WHERE organization_id = $1", [organizationId])).rows[0]?.n).toBe(before);
  });

  it('T158 prepares PAID internally for OWNER/ADMIN and rolls back stock when payment fails', async () => {
    await admin.query(`INSERT INTO membership_branches (organization_id, membership_id, branch_id)
      VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [organizationId, adminMembershipId, branchId]);
    const purchases = new PurchaseOperationsService(new TenantTransaction(runtime));
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '1', unitCost: '4.00' }] };
    await expect(purchases.preparePaid(context(organizationId, employeeId), input,
      { method: 'TRANSFER', amount: '4.00' }, randomUUID()))
      .rejects.toMatchObject({ code: 'PURCHASE_FORBIDDEN' });
    const before = (await admin.query('SELECT quantity::text FROM branch_stocks WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3',
      [organizationId, branchId, itemId])).rows[0]?.quantity;
    await expect(purchases.preparePaid(context(), input,
      { method: 'TRANSFER', amount: '3.00' }, randomUUID()))
      .rejects.toMatchObject({ code: 'PURCHASE_PAYMENT_INVALID' });
    expect((await admin.query('SELECT id FROM purchases WHERE id = $1', [input.clientOperationId])).rowCount).toBe(0);
    expect((await admin.query('SELECT quantity::text FROM branch_stocks WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3',
      [organizationId, branchId, itemId])).rows[0]?.quantity).toBe(before);
    const result = await purchases.preparePaid(context(), input,
      { method: 'TRANSFER', amount: '4.00' }, randomUUID());
    expect(result).toMatchObject({ id: input.clientOperationId, status: 'PAID', total: '4.00' });
    expect((await admin.query('SELECT method, amount::text FROM purchase_payments WHERE purchase_id = $1',
      [result.id])).rows[0]).toMatchObject({ method: 'TRANSFER', amount: '4.00' });
    expect((await admin.query('SELECT quantity::text FROM branch_stocks WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3',
      [organizationId, branchId, itemId])).rows[0]?.quantity).not.toBe(before);
    await expect(purchases.preparePaid(context(organizationId, adminId),
      { ...input, branchId: otherBranchId, clientOperationId: randomUUID() },
      { method: 'TRANSFER', amount: '4.00' }, randomUUID()))
      .rejects.toMatchObject({ code: 'PURCHASE_FORBIDDEN' });
    const adminPaid = await purchases.preparePaid(context(organizationId, adminId),
      { ...input, clientOperationId: randomUUID() },
      { method: 'TRANSFER', amount: '4.00' }, randomUUID());
    expect(adminPaid.status).toBe('PAID');
    await expect(purchases.preparePaid(context(otherOrganizationId),
      { ...input, clientOperationId: randomUUID() },
      { method: 'TRANSFER', amount: '4.00' }, randomUUID()))
      .rejects.toMatchObject({ code: 'PURCHASE_FORBIDDEN' });
  });

  it('T159 confirms a zero-total purchase as PAID without a zero payment', async () => {
    const purchases = new PurchaseOperationsService(new TenantTransaction(runtime));
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '2', unitCost: '0.00' }] };
    const key = randomUUID();
    const paid = await purchases.preparePaid(context(), input, null, key);
    expect(paid).toMatchObject({ id: input.clientOperationId, status: 'PAID', total: '0.00' });
    expect(await purchases.preparePaid(context(), input, null, key)).toEqual(paid);
    expect((await admin.query('SELECT count(*)::integer AS n FROM purchase_payments WHERE purchase_id = $1',
      [paid.id])).rows[0]?.n).toBe(0);
    expect((await admin.query("SELECT count(*)::integer AS n FROM inventory_movements WHERE source_type = 'PURCHASE' AND source_id = $1",
      [paid.id])).rows[0]?.n).toBe(1);
    await expect(purchases.preparePaid(context(), { ...input, clientOperationId: randomUUID() },
      { method: 'TRANSFER', amount: '0.00' }, randomUUID())).rejects.toMatchObject({ code: 'PURCHASE_PAYMENT_INVALID' });
  });

  it('T160 pays a pending purchase once with its exact positive balance and immutable history', async () => {
    const purchases = new PurchaseOperationsService(new TenantTransaction(runtime));
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '2', unitCost: '3.25' }] };
    const pending = await purchases.confirmPending(context(), input, randomUUID());
    const payment = { method: 'TRANSFER', amount: '6.50' };
    await expect(purchases.preparePendingPayment(context(), pending.id,
      { ...payment, amount: '3.25' }, randomUUID()))
      .rejects.toMatchObject({ code: 'PURCHASE_PAYMENT_INVALID' });
    await expect(purchases.preparePendingPayment(context(), pending.id,
      { ...payment, amount: '0.00' }, randomUUID()))
      .rejects.toMatchObject({ code: 'PURCHASE_PAYMENT_INVALID' });
    expect((await admin.query('SELECT count(*)::integer AS n FROM purchase_payments WHERE purchase_id = $1',
      [pending.id])).rows[0]?.n).toBe(0);
    const key = randomUUID();
    const paid = await purchases.preparePendingPayment(context(), pending.id, payment, key);
    expect(paid).toMatchObject({ id: pending.id, status: 'PAID', total: '6.50' });
    expect(await purchases.preparePendingPayment(context(), pending.id, payment, key)).toEqual(paid);
    expect((await admin.query('SELECT confirmation_status FROM purchases WHERE id = $1',
      [pending.id])).rows[0]?.confirmation_status).toBe('PENDING_PAYMENT');
    expect((await admin.query('SELECT method, amount::text FROM purchase_payments WHERE purchase_id = $1',
      [pending.id])).rows).toEqual([{ method: 'TRANSFER', amount: '6.50' }]);
    await expect(admin.query('UPDATE purchase_payments SET amount = 1 WHERE purchase_id = $1',
      [pending.id])).rejects.toMatchObject({ code: '55000' });
    await expect(purchases.preparePendingPayment(context(), pending.id, payment, randomUUID()))
      .rejects.toMatchObject({ code: 'PURCHASE_PAYMENT_INVALID' });
    await expect(purchases.preparePendingPayment(context(organizationId, employeeId), pending.id,
      payment, randomUUID())).rejects.toMatchObject({ code: 'PURCHASE_FORBIDDEN' });
    await expect(purchases.preparePendingPayment(context(otherOrganizationId), pending.id,
      payment, randomUUID())).rejects.toMatchObject({ code: 'PURCHASE_PAYMENT_INVALID' });
  });

  it('T161 locks the matching open device session and atomically records a cash purchase outflow', async () => {
    const transactions = new TenantTransaction(runtime);
    const purchases = new PurchaseOperationsService(transactions);
    const devices = new DeviceAuthorizationService(transactions);
    const device = await devices.authorizeOnline(context(), branchId);
    const otherDevice = await devices.authorizeOnline(context(), branchId);
    const registerId = randomUUID();
    const sessionId = randomUUID();
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, $4)',
      [registerId, organizationId, branchId, 'Compras']);
    await admin.query(`INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id,
      owner_user_id, device_id, origin, status, opening_cash, expected_cash, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', '5.00', '5.00', 'ARS')`,
      [sessionId, organizationId, branchId, registerId, ownerId, device.id]);
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '1', unitCost: '4.00' }] };
    const cash = { method: 'CASH', amount: '4.00', cashSessionId: sessionId, deviceId: device.id };
    await expect(purchases.preparePaid(context(), input,
      { ...cash, deviceId: otherDevice.id }, randomUUID()))
      .rejects.toMatchObject({ code: 'CASH_SESSION_DEVICE_CONFLICT' });
    expect((await admin.query('SELECT count(*)::integer AS n FROM purchases WHERE id = $1',
      [input.clientOperationId])).rows[0]?.n).toBe(0);
    await expect(purchases.preparePaid(context(), input,
      { ...cash, amount: '6.00' }, randomUUID()))
      .rejects.toMatchObject({ code: 'PURCHASE_PAYMENT_INVALID' });
    const paid = await purchases.preparePaid(context(), input, cash, randomUUID());
    expect(paid.status).toBe('PAID');
    expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1',
      [sessionId])).rows[0]?.expected_cash).toBe('1.00');
    expect((await admin.query(`SELECT delta::text, device_id FROM cash_movements
      WHERE source_type = 'PURCHASE' AND source_id = $1`, [paid.id])).rows)
      .toEqual([{ delta: '-4.00', device_id: device.id }]);
    const insufficientInput = { ...input, clientOperationId: randomUUID() };
    await expect(purchases.preparePaid(context(), insufficientInput, cash, randomUUID()))
      .rejects.toMatchObject({ code: 'CASH_INSUFFICIENT_EXPECTED' });
    expect((await admin.query('SELECT count(*)::integer AS n FROM purchases WHERE id = $1',
      [insufficientInput.clientOperationId])).rows[0]?.n).toBe(0);
    const pendingInput = { ...input, clientOperationId: randomUUID() };
    const pending = await purchases.confirmPending(context(), pendingInput, randomUUID());
    await expect(purchases.preparePendingPayment(context(), pending.id,
      { ...cash, deviceId: otherDevice.id }, randomUUID()))
      .rejects.toMatchObject({ code: 'CASH_SESSION_DEVICE_CONFLICT' });
    await expect(purchases.preparePendingPayment(context(), pending.id, cash, randomUUID()))
      .rejects.toMatchObject({ code: 'CASH_INSUFFICIENT_EXPECTED' });
    expect((await admin.query('SELECT count(*)::integer AS n FROM purchase_payments WHERE purchase_id = $1',
      [pending.id])).rows[0]?.n).toBe(0);
    expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1',
      [sessionId])).rows[0]?.expected_cash).toBe('1.00');
    const depositId = randomUUID();
    await admin.query(`INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id,
      actor_user_id, device_id, delta, currency_code, source_type, source_id, effect_kind)
      VALUES ($1, $2, $3, $4, $5, $6, '5.00', 'ARS', 'MANUAL', $1, 'IN')`,
      [depositId, organizationId, branchId, sessionId, ownerId, device.id]);
    const key = randomUUID();
    const paidPending = await purchases.preparePendingPayment(context(), pending.id, cash, key);
    expect(await purchases.preparePendingPayment(context(), pending.id, cash, key)).toEqual(paidPending);
    expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1',
      [sessionId])).rows[0]?.expected_cash).toBe('2.00');
    expect((await admin.query(`SELECT count(*)::integer AS n FROM cash_movements
      WHERE source_type = 'PURCHASE' AND source_id = $1`, [pending.id])).rows[0]?.n).toBe(1);
    expect((await admin.query(`SELECT count(*)::integer AS n FROM audit_events
      WHERE entity_id = $1 AND action = 'purchase.paid' AND device_id = $2`,
      [pending.id, device.id])).rows[0]?.n).toBe(1);
    await admin.query(`INSERT INTO cash_session_state_transitions (id, organization_id,
      cash_session_id, actor_user_id, from_status, to_status)
      VALUES ($1, $2, $3, $4, 'OPEN', 'CLOSING')`,
      [randomUUID(), organizationId, sessionId, ownerId]);
    const closedInput = { ...input, clientOperationId: randomUUID() };
    await expect(purchases.preparePaid(context(), closedInput, cash, randomUUID()))
      .rejects.toMatchObject({ code: 'CASH_SESSION_NOT_OPEN' });
    expect((await admin.query('SELECT count(*)::integer AS n FROM purchases WHERE id = $1',
      [closedInput.clientOperationId])).rows[0]?.n).toBe(0);
  });

  it('T162 pays by transfer with no open cash session and leaves cash untouched', async () => {
    const purchases = new PurchaseOperationsService(new TenantTransaction(runtime));
    const cashBefore = (await admin.query(`SELECT count(*)::integer AS n FROM cash_movements
      WHERE organization_id = $1`, [organizationId])).rows[0]?.n;
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '1', unitCost: '7.00' }] };
    const paid = await purchases.preparePaid(context(), input,
      { method: 'TRANSFER', amount: '7.00' }, randomUUID());
    expect(paid.status).toBe('PAID');
    const pending = await purchases.confirmPending(context(),
      { ...input, clientOperationId: randomUUID() }, randomUUID());
    expect((await purchases.preparePendingPayment(context(), pending.id,
      { method: 'TRANSFER', amount: '7.00' }, randomUUID())).status).toBe('PAID');
    expect((await admin.query(`SELECT count(*)::integer AS n FROM cash_movements
      WHERE organization_id = $1`, [organizationId])).rows[0]?.n).toBe(cashBefore);
  });

  it('T163 records one immutable cancellation with reason without changing the purchase', async () => {
    const transactions = new TenantTransaction(runtime);
    const purchases = new PurchaseOperationsService(transactions);
    const purchase = await purchases.confirmPending(context(), { branchId, supplierId,
      clientOperationId: randomUUID(), lines: [{ itemId, quantity: '1', unitCost: '2.00' }] }, randomUUID());
    const preparation = new PurchaseCancellationPreparation();
    const cancellation = await transactions.runWithOptionalAudit(context(), async (client) => {
      const prepared = await preparation.prepare(client, context(), purchase.id, '  Error de carga  ');
      await preparation.record(client, context(), prepared);
      return { result: prepared };
    });
    expect(cancellation.reason).toBe('Error de carga');
    expect((await admin.query('SELECT confirmation_status FROM purchases WHERE id = $1',
      [purchase.id])).rows[0]?.confirmation_status).toBe('PENDING_PAYMENT');
    expect((await admin.query('SELECT reason FROM purchase_cancellations WHERE purchase_id = $1',
      [purchase.id])).rows[0]?.reason).toBe('Error de carga');
    await expect(transactions.runWithOptionalAudit(context(), async (client) => ({ result:
      await preparation.prepare(client, context(), purchase.id, 'Otra vez') })))
      .rejects.toMatchObject({ code: 'PURCHASE_ALREADY_CANCELLED' });
  });

  it('T164 rejects a multi-item reversal in full when one stock is insufficient', async () => {
    const transactions = new TenantTransaction(runtime);
    const purchases = new PurchaseOperationsService(transactions);
    const secondItemId = randomUUID();
    await admin.query(`INSERT INTO catalog_items (id, organization_id, name, type,
      track_inventory, base_unit, price, price_version)
      VALUES ($1, $2, 'Segundo', 'PRODUCT', true, 'UNIT', '1.00', 1)`,
    [secondItemId, organizationId]);
    const purchase = await purchases.confirmPending(context(), { branchId, supplierId,
      clientOperationId: randomUUID(), lines: [
        { itemId, quantity: '2', unitCost: '1.00' },
        { itemId: secondItemId, quantity: '2', unitCost: '1.00' },
      ] }, randomUUID());
    await admin.query(`UPDATE branch_stocks SET quantity = 0
      WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3`,
    [organizationId, branchId, secondItemId]);
    const firstBefore = (await admin.query(`SELECT quantity::text FROM branch_stocks
      WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3`,
    [organizationId, branchId, itemId])).rows[0]?.quantity;
    const preparation = new PurchaseCancellationPreparation();
    await expect(transactions.runWithOptionalAudit(context(), async (client) => {
      const prepared = await preparation.prepare(client, context(), purchase.id, 'Reversión');
      await preparation.record(client, context(), prepared);
      await preparation.reverseStock(client, context(), prepared);
      return { result: prepared };
    })).rejects.toMatchObject({ code: 'PURCHASE_CANCELLATION_STOCK_INSUFFICIENT' });
    expect((await admin.query('SELECT count(*)::integer AS n FROM purchase_cancellations WHERE purchase_id = $1',
      [purchase.id])).rows[0]?.n).toBe(0);
    expect((await admin.query(`SELECT quantity::text FROM branch_stocks
      WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3`,
    [organizationId, branchId, itemId])).rows[0]?.quantity).toBe(firstBefore);
  });

  it('T165 cancels a paid transfer purchase atomically with stock, historic reversal and audit', async () => {
    const purchases = new PurchaseOperationsService(new TenantTransaction(runtime));
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '2', unitCost: '4.00' }] };
    const paid = await purchases.preparePaid(context(), input,
      { method: 'TRANSFER', amount: '8.00' }, randomUUID());
    await admin.query(`UPDATE payment_method_settings SET enabled = false
      WHERE organization_id = $1 AND method = 'TRANSFER'`, [organizationId]);
    const stockBefore = (await admin.query(`SELECT quantity::text FROM branch_stocks
      WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3`,
    [organizationId, branchId, itemId])).rows[0]?.quantity;
    const key = randomUUID();
    const cancelled = await purchases.cancel(context(), paid.id, { reason: 'Error de recepción' }, key);
    expect(cancelled).toMatchObject({ purchaseId: paid.id, status: 'CANCELLED' });
    expect(await purchases.cancel(context(), paid.id, { reason: 'Error de recepción' }, key)).toEqual(cancelled);
    expect((await admin.query(`SELECT method, amount::text FROM purchase_payment_reversals
      WHERE purchase_id = $1`, [paid.id])).rows).toEqual([{ method: 'TRANSFER', amount: '8.00' }]);
    expect((await admin.query(`SELECT quantity::text FROM branch_stocks
      WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3`,
    [organizationId, branchId, itemId])).rows[0]?.quantity).not.toBe(stockBefore);
    expect((await admin.query("SELECT count(*)::integer AS n FROM audit_events WHERE entity_id = $1 AND action = 'purchase.cancelled'",
      [paid.id])).rows[0]?.n).toBe(1);
    expect((await admin.query('SELECT confirmation_status FROM purchases WHERE id = $1',
      [paid.id])).rows[0]?.confirmation_status).toBe('PAID');
    await expect(purchases.cancel(context(), paid.id, { reason: 'Otra vez' }, randomUUID()))
      .rejects.toMatchObject({ code: 'PURCHASE_ALREADY_CANCELLED' });
    await admin.query(`UPDATE payment_method_settings SET enabled = true
      WHERE organization_id = $1 AND method = 'TRANSFER'`, [organizationId]);
  });

  it('T165 requires an operational cash session and restores the historical cash amount', async () => {
    const transactions = new TenantTransaction(runtime);
    const purchases = new PurchaseOperationsService(transactions);
    const device = await new DeviceAuthorizationService(transactions).authorizeOnline(context(), branchId);
    const wrongDevice = await new DeviceAuthorizationService(transactions).authorizeOnline(context(), branchId);
    const registerId = randomUUID();
    const sessionId = randomUUID();
    await admin.query(`INSERT INTO cash_registers (id, organization_id, branch_id, name)
      VALUES ($1, $2, $3, 'Anulaciones')`, [registerId, organizationId, branchId]);
    await admin.query(`INSERT INTO cash_sessions (id, organization_id, branch_id,
      cash_register_id, owner_user_id, device_id, origin, status,
      opening_cash, expected_cash, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', '10.00', '10.00', 'ARS')`,
    [sessionId, organizationId, branchId, registerId, ownerId, device.id]);
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '1', unitCost: '3.00' }] };
    const paid = await purchases.preparePaid(context(), input,
      { method: 'CASH', amount: '3.00', cashSessionId: sessionId, deviceId: device.id }, randomUUID());
    await expect(purchases.cancel(context(), paid.id, { reason: 'Error' }, randomUUID()))
      .rejects.toMatchObject({ code: 'PURCHASE_CANCELLATION_NOT_AVAILABLE' });
    await expect(purchases.cancel(context(), paid.id,
      { reason: 'Error', cashSessionId: sessionId, deviceId: wrongDevice.id }, randomUUID()))
      .rejects.toMatchObject({ code: 'CASH_SESSION_DEVICE_CONFLICT' });
    expect((await admin.query('SELECT count(*)::integer AS n FROM purchase_cancellations WHERE purchase_id = $1',
      [paid.id])).rows[0]?.n).toBe(0);
    const cancelled = await purchases.cancel(context(), paid.id,
      { reason: 'Error', cashSessionId: sessionId, deviceId: device.id }, randomUUID());
    expect(cancelled.status).toBe('CANCELLED');
    expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1',
      [sessionId])).rows[0]?.expected_cash).toBe('10.00');
    expect((await admin.query(`SELECT delta::text FROM cash_movements
      WHERE source_type = 'PURCHASE_CANCELLATION' AND source_id = $1`,
    [cancelled.id])).rows[0]?.delta).toBe('3.00');
  });

  it('T165 cancels pending history without a payment and denies cross-tenant access', async () => {
    const purchases = new PurchaseOperationsService(new TenantTransaction(runtime));
    const input = { branchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '1', unitCost: '1.00' }] };
    const pending = await purchases.confirmPending(context(), input, randomUUID());
    await expect(purchases.cancel(context(otherOrganizationId), pending.id,
      { reason: 'Ajena' }, randomUUID()))
      .rejects.toMatchObject({ code: 'PURCHASE_CANCELLATION_NOT_AVAILABLE' });
    const cancelled = await purchases.cancel(context(), pending.id,
      { reason: 'Duplicada' }, randomUUID());
    expect(cancelled.status).toBe('CANCELLED');
    expect((await admin.query('SELECT count(*)::integer AS n FROM purchase_payment_reversals WHERE purchase_id = $1',
      [pending.id])).rows[0]?.n).toBe(0);
    expect((await admin.query(`SELECT count(*)::integer AS n FROM inventory_movements
      WHERE source_type = 'PURCHASE_CANCELLATION' AND source_id = $1`,
    [cancelled.id])).rows[0]?.n).toBe(1);
    await expect(admin.query('UPDATE purchase_cancellations SET reason = $1 WHERE id = $2',
      ['alterado', cancelled.id])).rejects.toMatchObject({ code: '55000' });
  });

  it('T173C limits historical purchase detail by tenant, branch and receiving employee', async () => {
    const purchases = new PurchaseOperationsService(new TenantTransaction(runtime));
    const input = { branchId: otherBranchId, supplierId, clientOperationId: randomUUID(),
      lines: [{ itemId, quantity: '1', unitCost: '4.00' }] };
    const branchPurchase = await purchases.confirmPending(context(), input, randomUUID());
    expect((await purchases.detail(context(), branchPurchase.id)).total).toBe('4.00');
    await expect(purchases.detail(context(otherOrganizationId), branchPurchase.id))
      .rejects.toMatchObject({ status: 404 });
    await expect(purchases.detail(context(organizationId, adminId), branchPurchase.id))
      .rejects.toMatchObject({ status: 403 });
    await expect(purchases.detail(context(organizationId, employeeId), branchPurchase.id))
      .rejects.toMatchObject({ status: 403 });
    await expect(purchases.detail(context(organizationId, cashierId), branchPurchase.id))
      .rejects.toMatchObject({ status: 403 });

    const employeePurchase = await purchases.confirmPending(context(organizationId, employeeId),
      { ...input, branchId, clientOperationId: randomUUID() }, randomUUID());
    expect((await purchases.detail(context(organizationId, employeeId), employeePurchase.id)).id)
      .toBe(employeePurchase.id);
    await expect(purchases.detail(context(organizationId, employeeId),
      (await purchases.confirmPending(context(), { ...input, branchId,
        clientOperationId: randomUUID() }, randomUUID())).id))
      .rejects.toMatchObject({ status: 403 });
  });
});
