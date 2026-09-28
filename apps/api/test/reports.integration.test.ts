import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { OutboxDispatcher, OutboxWorker } from '../src/core/outbox/outbox-worker.js';
import type { ObjectStoragePort } from '../src/core/objects/object-storage.port.js';
import { ReportExportService } from '../src/modules/reports/report-export.service.js';
import { ReportsService } from '../src/modules/reports/reports.service.js';

describe('read-only report datasets', () => {
  let container: StartedPostgreSqlContainer;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let reports: ReportsService;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const branchId = randomUUID();
  const otherBranchId = randomUUID();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const cashierId = randomUUID();
  const employeeId = randomUUID();
  const sessionId = randomUUID();
  const saleId = randomUUID();
  const cancelledSaleId = randomUUID();
  const itemId = randomUUID();
  const itemWithoutMinimumId = randomUUID();
  const pendingPurchaseId = randomUUID();
  const paidPurchaseId = randomUUID();
  const cancelledPurchaseId = randomUUID();
  const supplierId = randomUUID();
  const expenseId = randomUUID();
  const cancelledExpenseId = randomUUID();

  const context = (userId = ownerId, tenantId = organizationId) => ({
    organizationId: tenantId, userId, requestId: randomUUID(),
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    ownerPool = new Pool({ connectionString: container.getConnectionUri() });
    await ownerPool.query("CREATE ROLE reports_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'reports_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    reports = new ReportsService(new TenantTransaction(runtimePool));
    await ownerPool.query(`INSERT INTO organizations (id,name,base_currency,timezone) VALUES
      ($1,'Reportes','ARS','America/Argentina/Buenos_Aires'),
      ($2,'Ajena','ARS','UTC')`, [organizationId, otherOrganizationId]);
    await ownerPool.query(`INSERT INTO branches (id,organization_id,name) VALUES
      ($1,$3,'Centro'),($2,$3,'Norte')`, [branchId, otherBranchId, organizationId]);
    await ownerPool.query(`INSERT INTO users (id,email_normalized,password_hash,password_hash_version) VALUES
      ($1,'reports-owner@example.com','$argon2id$v=19$owner',1),
      ($2,'reports-admin@example.com','$argon2id$v=19$admin',1),
      ($3,'reports-cashier@example.com','$argon2id$v=19$cashier',1),
      ($4,'reports-employee@example.com','$argon2id$v=19$employee',1)`,
    [ownerId, adminId, cashierId, employeeId]);
    const adminMembershipId = randomUUID();
    const cashierMembershipId = randomUUID();
    const employeeMembershipId = randomUUID();
    await ownerPool.query(`INSERT INTO memberships (id,organization_id,user_id,role) VALUES
      ($1,$5,$6,'OWNER'),($2,$5,$7,'ADMIN'),($3,$5,$8,'CASHIER'),($4,$5,$9,'EMPLOYEE')`,
    [randomUUID(), adminMembershipId, cashierMembershipId, employeeMembershipId,
      organizationId, ownerId, adminId, cashierId, employeeId]);
    await ownerPool.query(`INSERT INTO membership_branches (organization_id,membership_id,branch_id)
      VALUES ($1,$2,$5),($1,$3,$5),($1,$4,$5)`,
    [organizationId, adminMembershipId, cashierMembershipId, employeeMembershipId, branchId]);
    const registerId = randomUUID();
    const deviceId = randomUUID();
    await ownerPool.query("INSERT INTO cash_registers (id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Caja')",
      [registerId, organizationId, branchId]);
    await ownerPool.query(`INSERT INTO devices (id,organization_id,branch_id,authorized_by_user_id,
      authorized_at,status,last_config_version) VALUES ($1,$2,$3,$4,now(),'ACTIVE',0)`,
    [deviceId, organizationId, branchId, ownerId]);
    await ownerPool.query(`INSERT INTO cash_sessions (id,organization_id,branch_id,cash_register_id,
      owner_user_id,device_id,origin,status,opening_cash,expected_cash,currency_code)
      VALUES ($1,$2,$3,$4,$5,$6,'ONLINE','OPEN',0,0,'ARS')`,
    [sessionId, organizationId, branchId, registerId, cashierId, deviceId]);
    await ownerPool.query(`INSERT INTO cash_movements (id,organization_id,branch_id,
      cash_session_id,actor_user_id,device_id,delta,currency_code,source_type,source_id,
      effect_kind) VALUES ($1,$2,$3,$4,$5,$6,5,'ARS','MANUAL',$7,'IN')`,
    [randomUUID(), organizationId, branchId, sessionId, cashierId, deviceId, randomUUID()]);
    await ownerPool.query(`INSERT INTO sales (id,organization_id,branch_id,cash_session_id,device_id,
      actor_user_id,session_owner_user_id,client_operation_id,currency_code,subtotal,discount,total,
      receipt_snapshot,confirmed_at) VALUES
      ($1,$3,$4,$5,$6,$7,$7,$8,'ARS',100,0,100,'{}','2026-03-01T02:30:00Z'),
      ($2,$3,$4,$5,$6,$7,$7,$9,'ARS',40,0,40,'{}','2026-03-01T03:30:00Z')`,
    [saleId, cancelledSaleId, organizationId, branchId, sessionId, deviceId,
      cashierId, randomUUID(), randomUUID()]);
    await ownerPool.query(`INSERT INTO sale_cancellations (id,organization_id,sale_id,branch_id,
      actor_user_id,reason) VALUES ($1,$2,$3,$4,$5,'Anulada')`,
    [randomUUID(), organizationId, cancelledSaleId, branchId, ownerId]);
    await ownerPool.query(`INSERT INTO catalog_items (id,organization_id,name,type,track_inventory)
      VALUES ($1,$3,'Yerba','PRODUCT',true),($2,$3,'Azúcar','PRODUCT',true)`,
    [itemId, itemWithoutMinimumId, organizationId]);
    await ownerPool.query(`INSERT INTO inventory_movements (id,organization_id,branch_id,item_id,
      actor_user_id,delta,source_type,source_id,source_line_id,effect_kind)
      VALUES ($1,$2,$3,$4,$5,3,'ADJUSTMENT',$6,$7,'INCREASE')`,
    [randomUUID(), organizationId, branchId, itemId, ownerId, randomUUID(), randomUUID()]);
    await ownerPool.query(`UPDATE branch_stocks SET quantity = 3 WHERE organization_id = $1
      AND branch_id = $2 AND item_id = $3`, [organizationId, branchId, itemId]);
    await ownerPool.query(`INSERT INTO stock_thresholds (organization_id,branch_id,item_id,minimum)
      VALUES ($1,$2,$3,3)`, [organizationId, branchId, itemId]);
    await ownerPool.query("INSERT INTO suppliers (id,organization_id,name) VALUES ($1,$2,'Mayorista')",
      [supplierId, organizationId]);
    await ownerPool.query(`INSERT INTO purchases (id,organization_id,branch_id,supplier_id,
      actor_user_id,client_operation_id,confirmation_status,currency_code,total,supplier_snapshot)
      VALUES ($1,$4,$5,$6,$7,$8,'PENDING_PAYMENT','ARS',20,'{}'),
        ($2,$4,$5,$6,$7,$9,'PAID','ARS',30,'{}'),
        ($3,$4,$5,$6,$7,$10,'PAID','ARS',40,'{}')`,
    [pendingPurchaseId, paidPurchaseId, cancelledPurchaseId, organizationId, branchId,
      supplierId, ownerId, randomUUID(), randomUUID(), randomUUID()]);
    await ownerPool.query(`INSERT INTO purchase_payments (id,organization_id,purchase_id,method,
      amount,currency_code) VALUES ($1,$3,$4,'TRANSFER',30,'ARS'),
      ($2,$3,$5,'TRANSFER',40,'ARS')`,
    [randomUUID(), randomUUID(), organizationId, paidPurchaseId, cancelledPurchaseId]);
    await ownerPool.query(`INSERT INTO purchase_cancellations (id,organization_id,purchase_id,
      branch_id,actor_user_id,reason) VALUES ($1,$2,$3,$4,$5,'Anulada')`,
    [randomUUID(), organizationId, cancelledPurchaseId, branchId, ownerId]);
    const categoryId = randomUUID();
    await ownerPool.query("INSERT INTO expense_categories (id,organization_id,name) VALUES ($1,$2,'Servicios')",
      [categoryId, organizationId]);
    await ownerPool.query(`INSERT INTO expenses (id,organization_id,branch_id,expense_category_id,
      actor_user_id,concept,amount,method,currency_code) VALUES
      ($1,$3,$4,$5,$6,'Luz',10,'TRANSFER','ARS'),
      ($2,$3,$4,$5,$6,'Agua',15,'TRANSFER','ARS')`,
    [expenseId, cancelledExpenseId, organizationId, branchId, categoryId, ownerId]);
    await ownerPool.query(`INSERT INTO expense_cancellations (id,organization_id,expense_id,
      branch_id,actor_user_id,reason,method,amount,currency_code,effect_kind)
      VALUES ($1,$2,$3,$4,$5,'Anulada','TRANSFER',15,'ARS','NONCASH_REVERSAL')`,
    [randomUUID(), organizationId, cancelledExpenseId, branchId, ownerId]);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    await container?.stop();
  });

  it('keeps cancelled sales visible, excludes them from net, and uses tenant-local dates', async () => {
    const all = await reports.list(context(), 'sales', { limit: 25 });
    expect(all.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: saleId, status: 'CONFIRMED', total: '100.00' }),
      expect.objectContaining({ id: cancelledSaleId, status: 'CANCELLED', total: '40.00' }),
    ]));
    expect(all.net).toBe('100.00');
    const february = await reports.list(context(), 'sales', {
      limit: 25, from: '2026-02-28', to: '2026-03-01',
    });
    expect(february.items.map((item) => item.id)).toEqual([saleId]);
    expect(february.net).toBe('100.00');
    const firstPage = await reports.list(context(), 'sales', { limit: 1 });
    expect(firstPage.nextCursor).toBeTruthy();
    const cursor = JSON.parse(Buffer.from(firstPage.nextCursor ?? '', 'base64url').toString()) as {
      id: string; sortValue: string };
    const secondPage = await reports.list(context(), 'sales', { limit: 1, cursor });
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('restricts sales to authorized branches and cashier ownership', async () => {
    await expect(reports.list(context(adminId), 'sales', { limit: 25,
      branchId: otherBranchId })).rejects.toMatchObject({ code: 'REPORT_BRANCH_FORBIDDEN' });
    await expect(reports.list(context(employeeId), 'sales', { limit: 25 }))
      .rejects.toMatchObject({ code: 'REPORT_ACCESS_FORBIDDEN' });
    expect((await reports.list(context(cashierId), 'sales', { limit: 25 })).items)
      .toHaveLength(2);
    await expect(reports.list(context(ownerId, otherOrganizationId), 'sales',
      { limit: 25 })).rejects.toMatchObject({ code: 'REPORT_ACCESS_FORBIDDEN' });
  });

  it('includes a cashier sale when the cashier acted in an authorized owner session', async () => {
    const sale = randomUUID();
    await ownerPool.query(`INSERT INTO sales (id,organization_id,branch_id,cash_session_id,
      device_id,actor_user_id,session_owner_user_id,client_operation_id,currency_code,
      subtotal,discount,total,receipt_snapshot)
      SELECT $1,organization_id,branch_id,id,device_id,$2,$3,$4,'ARS',7,0,7,'{}'
      FROM cash_sessions WHERE id = $5`,
    [sale, cashierId, ownerId, randomUUID(), sessionId]);
    const result = await reports.list(context(cashierId), 'sales', { limit: 25 });
    expect(result.items.map((item) => item.id)).toContain(sale);
  });

  it('enforces tenant, branch and role scope for every report dataset', async () => {
    const datasets = ['sales', 'inventory', 'inventory-movements', 'cash',
      'purchases', 'expenses'] as const;
    for (const dataset of datasets) {
      const owner = await reports.list(context(), dataset, { limit: 25,
        branchId: otherBranchId });
      expect(owner.items.every((item) => item.branchId === otherBranchId)).toBe(true);
      await expect(reports.list(context(ownerId, otherOrganizationId), dataset,
        { limit: 25 })).rejects.toMatchObject({ code: 'REPORT_ACCESS_FORBIDDEN' });
      await expect(reports.list(context(adminId), dataset,
        { limit: 25, branchId: otherBranchId }))
        .rejects.toMatchObject({ code: 'REPORT_BRANCH_FORBIDDEN' });
    }
    for (const dataset of ['sales', 'cash'] as const) {
      await expect(reports.list(context(employeeId), dataset, { limit: 25 }))
        .rejects.toMatchObject({ code: 'REPORT_ACCESS_FORBIDDEN' });
      await expect(reports.list(context(cashierId), dataset, { limit: 25,
        branchId: otherBranchId })).rejects.toMatchObject({ code: 'REPORT_BRANCH_FORBIDDEN' });
    }
    for (const dataset of ['inventory', 'inventory-movements'] as const) {
      await expect(reports.list(context(cashierId), dataset, { limit: 25 }))
        .rejects.toMatchObject({ code: 'REPORT_ACCESS_FORBIDDEN' });
      await expect(reports.list(context(employeeId), dataset, { limit: 25,
        branchId: otherBranchId })).rejects.toMatchObject({ code: 'REPORT_BRANCH_FORBIDDEN' });
    }
    for (const dataset of ['purchases', 'expenses'] as const) {
      for (const userId of [cashierId, employeeId]) {
        await expect(reports.list(context(userId), dataset, { limit: 25 }))
          .rejects.toMatchObject({ code: 'REPORT_ACCESS_FORBIDDEN' });
      }
    }
  });

  it('lists current inventory and flags only configured inclusive minimums', async () => {
    const all = await reports.list(context(employeeId), 'inventory', { limit: 25 });
    expect(all.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId, quantity: '3.000', minimum: '3.000', lowStock: true }),
      expect.objectContaining({ itemId: itemWithoutMinimumId, quantity: '0.000',
        minimum: null, lowStock: false }),
    ]));
    const low = await reports.list(context(), 'inventory', { limit: 25, lowStock: true });
    expect(low.items.map((item) => item.itemId)).toEqual([itemId]);
    await expect(reports.list(context(cashierId), 'inventory', { limit: 25 }))
      .rejects.toMatchObject({ code: 'REPORT_ACCESS_FORBIDDEN' });
  });

  it('lists inventory movements with source, signed quantity and authorized scope', async () => {
    const result = await reports.list(context(employeeId), 'inventory-movements', { limit: 25 });
    expect(result.items).toContainEqual(expect.objectContaining({ itemId,
      sourceType: 'ADJUSTMENT', delta: '3.000', effectKind: 'INCREASE' }));
    const empty = await reports.list(context(employeeId), 'inventory-movements', {
      limit: 25, from: '2027-01-01',
    });
    expect(empty.items).toEqual([]);
    await expect(reports.list(context(adminId), 'inventory-movements', { limit: 25,
      branchId: otherBranchId })).rejects.toMatchObject({ code: 'REPORT_BRANCH_FORBIDDEN' });
  });

  it('lists cash sessions and movements, with no invented difference for an open session', async () => {
    const sessions = await reports.list(context(cashierId), 'cash', { limit: 25 });
    expect(sessions.items).toContainEqual(expect.objectContaining({ id: sessionId,
      status: 'OPEN', expectedCash: '5.00', movementTotal: '5.00',
      movementCount: 1, countedCash: null, difference: null }));
    await expect(reports.list(context(employeeId), 'cash', { limit: 25 }))
      .rejects.toMatchObject({ code: 'REPORT_ACCESS_FORBIDDEN' });
  });

  it('reads immutable cash closing differences without changing the historical session', async () => {
    const closedId = randomUUID();
    const registerId = randomUUID();
    const register = await ownerPool.query<{ device_id: string }>(
      'SELECT device_id FROM cash_sessions WHERE id = $1', [sessionId]);
    const deviceId = register.rows[0]?.device_id;
    expect(deviceId).toBeDefined();
    await ownerPool.query(`INSERT INTO cash_registers (id,organization_id,branch_id,name)
      VALUES ($1,$2,$3,'Caja de cierre')`, [registerId, organizationId, branchId]);
    await ownerPool.query(`INSERT INTO cash_sessions (id,organization_id,branch_id,
      cash_register_id,owner_user_id,device_id,origin,status,opening_cash,expected_cash,currency_code)
      VALUES ($1,$2,$3,$4,$5,$6,'ONLINE','OPEN',10,10,'ARS')`,
    [closedId, organizationId, branchId, registerId, cashierId, deviceId]);
    await ownerPool.query(`INSERT INTO cash_session_state_transitions
      (id,organization_id,cash_session_id,actor_user_id,from_status,to_status)
      VALUES ($1,$2,$3,$4,'OPEN','CLOSING'),($5,$2,$3,$4,'CLOSING','CLOSED')`,
    [randomUUID(), organizationId, closedId, ownerId, randomUUID()]);
    await ownerPool.query(`INSERT INTO cash_session_closures
      (id,organization_id,branch_id,cash_session_id,actor_user_id,expected_cash,counted_cash,
       difference,currency_code)
      VALUES ($1,$2,$3,$4,$5,10,8,-2,'ARS')`,
    [randomUUID(), organizationId, branchId, closedId, ownerId]);
    const result = await reports.list(context(), 'cash', { limit: 25 });
    expect(result.items).toContainEqual(expect.objectContaining({ id: closedId,
      countedCash: '8.00', difference: '-2.00' }));
    await expect(reports.list(context(employeeId), 'cash', { limit: 25 }))
      .rejects.toMatchObject({ code: 'REPORT_ACCESS_FORBIDDEN' });
  });

  it('lists historical purchase states and excludes cancelled purchases from net', async () => {
    const result = await reports.list(context(), 'purchases', { limit: 25 });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pendingPurchaseId, status: 'PENDING_PAYMENT' }),
      expect.objectContaining({ id: paidPurchaseId, status: 'PAID' }),
      expect.objectContaining({ id: cancelledPurchaseId, status: 'CANCELLED' }),
    ]));
    expect(result.net).toBe('50.00');
    await expect(reports.list(context(employeeId), 'purchases', { limit: 25 }))
      .rejects.toMatchObject({ code: 'REPORT_ACCESS_FORBIDDEN' });
  });

  it('lists historical expenses while excluding cancellations from net', async () => {
    const result = await reports.list(context(), 'expenses', { limit: 25 });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expenseId, status: 'CONFIRMED', amount: '10.00' }),
      expect.objectContaining({ id: cancelledExpenseId, status: 'CANCELLED', amount: '15.00' }),
    ]));
    expect(result.net).toBe('10.00');
    const cancelled = await reports.list(context(), 'expenses', { limit: 25,
      status: 'CANCELLED' });
    expect(cancelled.items.map((item) => item.id)).toEqual([cancelledExpenseId]);
    await expect(reports.list(context(cashierId), 'expenses', { limit: 25 }))
      .rejects.toMatchObject({ code: 'REPORT_ACCESS_FORBIDDEN' });
  });

  it('uses tenant-local midnight for purchase and expense periods without hiding cancellations', async () => {
    const category = await ownerPool.query<{ id: string }>(
      'SELECT id FROM expense_categories WHERE organization_id = $1 LIMIT 1', [organizationId]);
    const purchaseBefore = randomUUID();
    const purchaseInPeriod = randomUUID();
    const expenseBefore = randomUUID();
    const expenseInPeriod = randomUUID();
    await ownerPool.query(`INSERT INTO purchases (id,organization_id,branch_id,supplier_id,
      actor_user_id,client_operation_id,confirmation_status,currency_code,total,
      supplier_snapshot,confirmed_at) VALUES
      ($1,$3,$4,$5,$6,$7,'PENDING_PAYMENT','ARS',11,'{}','2026-03-01T02:30:00Z'),
      ($2,$3,$4,$5,$6,$8,'PENDING_PAYMENT','ARS',12,'{}','2026-03-01T03:30:00Z')`,
    [purchaseBefore, purchaseInPeriod, organizationId, branchId, supplierId, ownerId,
      randomUUID(), randomUUID()]);
    await ownerPool.query(`INSERT INTO purchase_cancellations
      (id,organization_id,purchase_id,branch_id,actor_user_id,reason)
      VALUES ($1,$2,$3,$4,$5,'Anulada')`,
    [randomUUID(), organizationId, purchaseInPeriod, branchId, ownerId]);
    await ownerPool.query(`INSERT INTO expenses (id,organization_id,branch_id,
      expense_category_id,actor_user_id,concept,amount,method,currency_code,occurred_at)
      VALUES ($1,$3,$4,$5,$6,'Previo',13,'TRANSFER','ARS','2026-03-01T02:30:00Z'),
        ($2,$3,$4,$5,$6,'Anulado',14,'TRANSFER','ARS','2026-03-01T03:30:00Z')`,
    [expenseBefore, expenseInPeriod, organizationId, branchId, category.rows[0]?.id, ownerId]);
    await ownerPool.query(`INSERT INTO expense_cancellations (id,organization_id,expense_id,
      branch_id,actor_user_id,reason,method,amount,currency_code,effect_kind)
      VALUES ($1,$2,$3,$4,$5,'Anulada','TRANSFER',14,'ARS','NONCASH_REVERSAL')`,
    [randomUUID(), organizationId, expenseInPeriod, branchId, ownerId]);
    for (const [dataset, included, excluded] of [
      ['purchases', purchaseInPeriod, purchaseBefore],
      ['expenses', expenseInPeriod, expenseBefore],
    ] as const) {
      const result = await reports.list(context(), dataset, { limit: 25,
        from: '2026-03-01', to: '2026-03-02' });
      expect(result.items.map((item) => item.id)).toContain(included);
      expect(result.items.map((item) => item.id)).not.toContain(excluded);
      expect(result.items).toContainEqual(expect.objectContaining({ id: included,
        status: 'CANCELLED' }));
      expect(result.net).toBe('0.00');
    }
  });

  it('queues PDF export and revalidates actor scope in the outbox worker', async () => {
    const uploaded = new Map<string, Uint8Array>();
    const storage: ObjectStoragePort = {
      put: async (key, body) => { uploaded.set(key, body); },
      signedGetUrl: async () => 'https://objects.example.test/report.pdf',
      delete: async (key) => { uploaded.delete(key); },
    };
    const exports = new ReportExportService(new TenantTransaction(runtimePool), reports, storage);
    const allowed = await exports.queue(context(), 'expenses', { limit: 100, branchId }, randomUUID());
    const revoked = await exports.queue(context(adminId), 'expenses',
      { limit: 100, branchId }, randomUUID());
    expect((await ownerPool.query(`SELECT count(*)::int AS count FROM outbox_jobs
      WHERE job_type = 'REPORT_PDF' AND payload->>'exportId' IN ($1,$2)`,
    [allowed.id, revoked.id])).rows[0]?.count).toBe(2);
    const foreign = await runtimePool.connect();
    try {
      await foreign.query('BEGIN READ ONLY');
      await foreign.query("SELECT set_config('app.organization_id',$1,true)",
        [otherOrganizationId]);
      expect((await foreign.query('SELECT id FROM report_exports WHERE id = $1',
        [allowed.id])).rows).toEqual([]);
      await foreign.query('COMMIT');
    } finally { foreign.release(); }
    await ownerPool.query(`DELETE FROM membership_branches WHERE organization_id = $1
      AND membership_id = (SELECT id FROM memberships
        WHERE organization_id = $1 AND user_id = $2)`, [organizationId, adminId]);
    const worker = new OutboxWorker({ dispatcher: new OutboxDispatcher(ownerPool),
      authorizer: { authorize: async () => undefined },
      handlers: { REPORT_PDF: (job, client) => exports.handle(job, client) },
      maxAttempts: 3, retryBaseSeconds: 1,
      tenantTransactions: new TenantTransaction(runtimePool), workerUserId: ownerId });
    const results = await worker.processAvailable(10, 60);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'COMPLETED' }),
    ]));
    expect((await exports.get(context(), allowed.id)).status).toBe('READY');
    expect((await ownerPool.query('SELECT status FROM report_exports WHERE id = $1',
      [revoked.id])).rows[0]?.status).toBe('FAILED');
    expect(uploaded.size).toBe(1);
    expect(Buffer.from([...uploaded.values()][0] ?? []).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('marks an export failed atomically when rendering exhausts worker retries', async () => {
    const storage: ObjectStoragePort = {
      put: async () => { throw new Error('storage unavailable'); },
      signedGetUrl: async () => '', delete: async () => undefined,
    };
    const exports = new ReportExportService(new TenantTransaction(runtimePool), reports, storage);
    const queued = await exports.queue(context(), 'expenses', { limit: 100, branchId }, randomUUID());
    const worker = new OutboxWorker({ dispatcher: new OutboxDispatcher(ownerPool),
      authorizer: { authorize: async () => undefined },
      handlers: { REPORT_PDF: (job, client) => exports.handle(job, client) },
      onDeadLetter: (job, client) => exports.markDeadLetter(job.organizationId, job.jobId, client),
      maxAttempts: 1, retryBaseSeconds: 1,
      tenantTransactions: new TenantTransaction(runtimePool), workerUserId: ownerId });
    expect(await worker.processAvailable(10, 60)).toContainEqual(
      expect.objectContaining({ status: 'DEAD_LETTER' }));
    expect((await ownerPool.query('SELECT status FROM report_exports WHERE id = $1',
      [queued.id])).rows[0]?.status).toBe('FAILED');
  });
});
