import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
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
});
