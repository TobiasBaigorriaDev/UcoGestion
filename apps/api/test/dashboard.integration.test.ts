import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { DashboardService } from '../src/modules/dashboard/dashboard.service.js';

describe('dashboard', () => {
  let container: StartedPostgreSqlContainer;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let service: DashboardService;
  const organizationId = randomUUID();
  const foreignOrganizationId = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const cashierId = randomUUID();
  const employeeId = randomUUID();
  const itemId = randomUUID();
  const saleId = randomUUID();
  const secondSaleId = randomUUID();
  const expenseId = randomUUID();
  const purchaseId = randomUUID();
  const sessionId = randomUUID();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    ownerPool = new Pool({ connectionString: container.getConnectionUri() });
    await ownerPool.query("CREATE ROLE dashboard_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'dashboard_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    service = new DashboardService(new TenantTransaction(runtimePool));
    await ownerPool.query(`INSERT INTO organizations (id, name, base_currency, timezone) VALUES
      ($1, 'Dashboard A', 'ARS', 'America/Argentina/Mendoza'),
      ($2, 'Dashboard B', 'ARS', 'America/Argentina/Mendoza')`,
    [organizationId, foreignOrganizationId]);
    await ownerPool.query(`INSERT INTO branches (id, organization_id, name) VALUES
      ($1,$3,'Centro'),($2,$3,'Norte')`, [branchA, branchB, organizationId]);
    await ownerPool.query(`INSERT INTO users (id,email_normalized,password_hash,password_hash_version) VALUES
      ($1,'dashboard-owner@example.com','$argon2id$v=19$owner',1),
      ($2,'dashboard-admin@example.com','$argon2id$v=19$admin',1),
      ($3,'dashboard-cashier@example.com','$argon2id$v=19$cashier',1),
      ($4,'dashboard-employee@example.com','$argon2id$v=19$employee',1)`,
    [ownerId, adminId, cashierId, employeeId]);
    const adminMembershipId = randomUUID();
    const cashierMembershipId = randomUUID();
    const employeeMembershipId = randomUUID();
    await ownerPool.query(`INSERT INTO memberships (id,organization_id,user_id,role) VALUES
      ($1,$5,$6,'OWNER'),($2,$5,$7,'ADMIN'),($3,$5,$8,'CASHIER'),($4,$5,$9,'EMPLOYEE')`,
    [randomUUID(), adminMembershipId, cashierMembershipId, employeeMembershipId,
      organizationId, ownerId, adminId, cashierId, employeeId]);
    await ownerPool.query(`INSERT INTO memberships (id,organization_id,user_id,role)
      VALUES ($1,$2,$3,'OWNER')`, [randomUUID(), foreignOrganizationId, ownerId]);
    await ownerPool.query(`INSERT INTO membership_branches (organization_id,membership_id,branch_id)
      VALUES ($1,$2,$4),($1,$3,$4),($1,$5,$6)`,
    [organizationId, adminMembershipId, cashierMembershipId, branchA, employeeMembershipId, branchB]);
    const registerId = randomUUID();
    const deviceId = randomUUID();
    await ownerPool.query("INSERT INTO cash_registers (id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Caja')",
      [registerId, organizationId, branchA]);
    await ownerPool.query(`INSERT INTO devices (id,organization_id,branch_id,authorized_by_user_id,
      authorized_at,status,last_config_version) VALUES ($1,$2,$3,$4,now(),'ACTIVE',0)`,
    [deviceId, organizationId, branchA, ownerId]);
    await ownerPool.query(`INSERT INTO cash_sessions (id,organization_id,branch_id,cash_register_id,
      owner_user_id,device_id,origin,status,opening_cash,expected_cash,currency_code)
      VALUES ($1,$2,$3,$4,$5,$6,'ONLINE','OPEN',100,100,'ARS')`,
    [sessionId, organizationId, branchA, registerId, cashierId, deviceId]);
    await ownerPool.query(`INSERT INTO catalog_items (id,organization_id,name,type,track_inventory)
      VALUES ($1,$2,'Yerba','PRODUCT',true)`, [itemId, organizationId]);
    await ownerPool.query(`INSERT INTO stock_thresholds (organization_id,branch_id,item_id,minimum)
      VALUES ($1,$2,$3,3)`, [organizationId, branchA, itemId]);
    await ownerPool.query(`INSERT INTO sales (id,organization_id,branch_id,cash_session_id,device_id,
      actor_user_id,session_owner_user_id,client_operation_id,currency_code,subtotal,discount,total,receipt_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'ARS',100,0,100,'{}'),
             ($8,$2,$3,$4,$5,$6,$6,$9,'ARS',40,0,40,'{}')`,
    [saleId, organizationId, branchA, sessionId, deviceId, cashierId, randomUUID(),
      secondSaleId, randomUUID()]);
    await ownerPool.query(`INSERT INTO sale_items (id,organization_id,sale_id,item_id,item_name,item_type,
      unit,quantity,unit_price,price_version,line_total,currency_code)
      VALUES ($1,$2,$3,$4,'Yerba','PRODUCT','UNIT',2,50,1,100,'ARS')`,
    [randomUUID(), organizationId, saleId, itemId]);
    await ownerPool.query(`INSERT INTO sale_payments (id,organization_id,sale_id,method,applied_amount,
      received_amount,change_amount,currency_code) VALUES ($1,$2,$3,'CASH',100,100,0,'ARS')`,
    [randomUUID(), organizationId, saleId]);
    const categoryId = randomUUID();
    await ownerPool.query("INSERT INTO expense_categories (id,organization_id,name) VALUES ($1,$2,'Servicios')",
      [categoryId, organizationId]);
    await ownerPool.query(`INSERT INTO expenses (id,organization_id,branch_id,expense_category_id,
      actor_user_id,concept,amount,method,currency_code) VALUES
      ($1,$2,$3,$4,$5,'Alquiler',25,'TRANSFER','ARS')`,
    [expenseId, organizationId, branchA, categoryId, ownerId]);
    const supplierId = randomUUID();
    await ownerPool.query("INSERT INTO suppliers (id,organization_id,name) VALUES ($1,$2,'Proveedor')",
      [supplierId, organizationId]);
    await ownerPool.query(`INSERT INTO purchases (id,organization_id,branch_id,supplier_id,actor_user_id,
      client_operation_id,confirmation_status,currency_code,total,supplier_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,'PAID','ARS',30,'{}')`,
    [purchaseId, organizationId, branchA, supplierId, ownerId, randomUUID()]);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    await container?.stop();
  });

  it('returns commercial metrics for OWNER and authorized branch filters for ADMIN', async () => {
    const owner = await service.get(context(ownerId), {});
    if (owner.role !== 'OWNER' && owner.role !== 'ADMIN') throw new Error('Expected management dashboard');
    expect(owner).toMatchObject({ role: 'OWNER', sales: { net: '140.00', count: 2,
      averageTicket: '70.00' }, expenses: { net: '25.00' }, purchases: { net: '30.00' } });
    expect(owner.paymentMethods).toContainEqual({ method: 'CASH', total: '100.00' });
    expect(owner.topItems[0]).toMatchObject({ itemId, quantity: '2.000' });
    expect(owner.lowStock[0]).toMatchObject({ itemId, branchId: branchA });
    expect(owner.cashSessions).toContainEqual(expect.objectContaining({ branchId: branchA,
      expectedCash: '100.00' }));
    expect(owner.cashSummary).toContainEqual({ branchId: branchA, status: 'OPEN',
      count: 1, expectedCash: '100.00' });
    expect(await service.get(context(adminId), { branchId: branchA })).toMatchObject({
      role: 'ADMIN', sales: { net: '140.00', count: 2 },
    });
    expect(await service.get(context(ownerId), { from: '2100-01-01T00:00:00Z' }))
      .toMatchObject({ sales: { net: '0.00', count: 0 } });
    expect(await service.get({ organizationId: foreignOrganizationId, userId: ownerId,
      requestId: randomUUID() }, {})).toMatchObject({ sales: { net: '0.00', count: 0 } });
    await expect(service.get(context(adminId), { branchId: branchB }))
      .rejects.toMatchObject({ code: 'DASHBOARD_BRANCH_FORBIDDEN' });
  });

  it('excludes cancelled documents from net totals and calculates operating result without margin', async () => {
    await ownerPool.query(`INSERT INTO sale_cancellations (id,organization_id,sale_id,branch_id,
      actor_user_id,reason) VALUES ($1,$2,$3,$4,$5,'Anulada')`,
    [randomUUID(), organizationId, saleId, branchA, ownerId]);
    await ownerPool.query(`INSERT INTO expense_cancellations (id,organization_id,expense_id,
      branch_id,actor_user_id,reason,method,amount,currency_code,effect_kind)
      VALUES ($1,$2,$3,$4,$5,'Anulado','TRANSFER',25,'ARS','NONCASH_REVERSAL')`,
    [randomUUID(), organizationId, expenseId, branchA, ownerId]);
    await ownerPool.query(`INSERT INTO purchase_cancellations (id,organization_id,purchase_id,
      branch_id,actor_user_id,reason) VALUES ($1,$2,$3,$4,$5,'Anulada')`,
    [randomUUID(), organizationId, purchaseId, branchA, ownerId]);
    const result = await service.get(context(ownerId), {});
    expect(result).toMatchObject({ sales: { net: '40.00', count: 1, averageTicket: '40.00' },
      expenses: { net: '0.00' }, purchases: { net: '0.00' },
      operatingResult: { amount: '40.00', label: 'Resultado operativo' },
      paymentMethods: [], topItems: [] });
    expect(JSON.stringify(result)).not.toMatch(/margin|profit|cost|margen|rentabilidad/i);
  });

  it('limits CASHIER to own sales and sessions and EMPLOYEE to scoped catalog and inventory', async () => {
    const registerId = randomUUID();
    const deviceId = randomUUID();
    const otherSessionId = randomUUID();
    await ownerPool.query("INSERT INTO cash_registers (id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Otra caja')",
      [registerId, organizationId, branchA]);
    await ownerPool.query(`INSERT INTO devices (id,organization_id,branch_id,authorized_by_user_id,
      authorized_at,status,last_config_version) VALUES ($1,$2,$3,$4,now(),'ACTIVE',0)`,
    [deviceId, organizationId, branchA, ownerId]);
    await ownerPool.query(`INSERT INTO cash_sessions (id,organization_id,branch_id,cash_register_id,
      owner_user_id,device_id,origin,status,opening_cash,expected_cash,currency_code)
      VALUES ($1,$2,$3,$4,$5,$6,'ONLINE','OPEN',0,0,'ARS')`,
    [otherSessionId, organizationId, branchA, registerId, ownerId, deviceId]);
    await ownerPool.query(`INSERT INTO sales (id,organization_id,branch_id,cash_session_id,device_id,
      actor_user_id,session_owner_user_id,client_operation_id,currency_code,subtotal,discount,total,
      receipt_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'ARS',60,0,60,'{}')`,
    [randomUUID(), organizationId, branchA, otherSessionId, deviceId, ownerId, randomUUID()]);
    const cashier = await service.get(context(cashierId), {});
    if (cashier.role !== 'CASHIER') throw new Error('Expected cashier dashboard');
    expect(cashier).toMatchObject({ role: 'CASHIER', sales: { net: '40.00', count: 1 },
      cashSessions: [expect.objectContaining({ id: sessionId })] });
    expect(cashier.cashSessions).toHaveLength(1);
    expect(JSON.stringify(cashier)).not.toMatch(/expenses|purchases|operatingResult|topItems|lowStock/i);
    const employee = await service.get(context(employeeId), {});
    expect(employee).toMatchObject({ role: 'EMPLOYEE', branchIds: [branchB],
      catalog: expect.arrayContaining([expect.objectContaining({ itemId })]),
      inventory: expect.arrayContaining([expect.objectContaining({ itemId, branchId: branchB })]) });
    expect(JSON.stringify(employee)).not.toMatch(/sales|expenses|purchases|cashSessions|operatingResult|cost|margin/i);
    await expect(service.get(context(employeeId), { branchId: branchA }))
      .rejects.toMatchObject({ code: 'DASHBOARD_BRANCH_FORBIDDEN' });
  });

  function context(userId: string) { return { organizationId, userId, requestId: randomUUID() }; }
});
