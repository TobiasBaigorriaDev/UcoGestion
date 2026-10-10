import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { BranchManagementService } from '../src/modules/branches/branch-management.service.js';
import { CatalogItemCreationService } from '../src/modules/catalog/catalog-item-creation.service.js';
import { CatalogPriceService } from '../src/modules/catalog/catalog-price.service.js';
import { CatalogItemLifecycleService } from '../src/modules/catalog/catalog-item-lifecycle.service.js';
import { InventoryAdjustmentService } from '../src/modules/inventory/inventory-adjustment.service.js';
import { InventoryIncreaseService } from '../src/modules/inventory/inventory-increase.service.js';
import { DeviceAuthorizationService } from '../src/modules/cash/device-authorization.service.js';
import { CashOperationsService } from '../src/modules/cash/cash-operations.service.js';
import { SalesOperationsService } from '../src/modules/sales/sales-operations.service.js';
import { PurchaseOperationsService } from '../src/modules/purchases/purchase-operations.service.js';
import { ExpenseOperationsService } from '../src/modules/expenses/expense-operations.service.js';

let container: StartedPostgreSqlContainer, admin: Pool, runtime: Pool;
const actor = randomUUID();
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  await runMigrations(container.getConnectionUri());
  admin = new Pool({connectionString:container.getConnectionUri()});
  await admin.query("CREATE ROLE monetary_runtime LOGIN PASSWORD 'test' IN ROLE uco_app");
  const url = new URL(container.getConnectionUri());url.username='monetary_runtime';url.password='test';
  runtime = new Pool({connectionString:url.toString()});
  await admin.query("INSERT INTO users(id,email_normalized,password_hash,password_hash_version) VALUES($1,'currency@example.com','$argon2id$v=19$test',1)",[actor]);
});
afterAll(async () => { await runtime?.end();await admin?.end();await container?.stop(); });

it.each(['ARS','USD'] as const)('RF-205/RF-251 preserves %s across every monetary class and positive compensations', async currency => {
  const organizationId=randomUUID(),context={organizationId,userId:actor,requestId:randomUUID()},tx=new TenantTransaction(runtime);
  await admin.query("INSERT INTO organizations(id,base_currency,timezone) VALUES($1,$2,'UTC')",[organizationId,currency]);
  await admin.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'OWNER')",[randomUUID(),organizationId,actor]);
  const branch=await new BranchManagementService(tx).create(context,{name:'Monetary branch'});
  const item=await new CatalogItemCreationService(tx).create(context,{name:'Monetary product',type:'PRODUCT',trackInventory:true});
  const price=await new CatalogPriceService(tx).setPrice(context,item.id,1,'3.00');
  expect(price.currency).toBe(currency);
  await new InventoryIncreaseService(tx).confirm(context,{branchId:branch.id,itemId:item.id,quantity:'5',reason:'INVENTARIO_INICIAL'},randomUUID());
  const register=randomUUID(),supplier=randomUUID(),category=randomUUID();
  await admin.query("INSERT INTO cash_registers(id,organization_id,branch_id,name) VALUES($1,$2,$3,'Monetary register')",[register,organizationId,branch.id]);
  await admin.query("INSERT INTO suppliers(id,organization_id,name) VALUES($1,$2,'Monetary supplier')",[supplier,organizationId]);
  await admin.query("INSERT INTO expense_categories(id,organization_id,name) VALUES($1,$2,'Monetary category')",[category,organizationId]);
  const device=await new DeviceAuthorizationService(tx).authorizeOnline(context,branch.id),cash=new CashOperationsService(tx);
  const session=await cash.open(context,{branchId:branch.id,cashRegisterId:register,deviceId:device.id,openingCash:'100.00'},randomUUID());
  expect(session.currencyCode).toBe(currency);
  await cash.deposit(context,{cashSessionId:session.id,deviceId:device.id,amount:'10.00',reason:'Cambio'},randomUUID());
  await cash.withdraw(context,{cashSessionId:session.id,deviceId:device.id,amount:'5.00',reason:'Retiro'},randomUUID());
  const sales=new SalesOperationsService(tx),lines=[{itemId:item.id,quantity:'1'}];
  const quote=await sales.quote(context,branch.id,lines);
  expect(quote.quote.currency).toBe(currency);
  const sale=await sales.confirm(context,{branchId:branch.id,cashSessionId:session.id,deviceId:device.id,
    clientOperationId:randomUUID(),lines,quoteFingerprint:quote.quoteFingerprint,
    payments:[{method:'CASH',appliedAmount:'3.00',receivedAmount:'5.00'}]},randomUUID());
  const purchases=new PurchaseOperationsService(tx);
  const purchase=await purchases.preparePaid(context,{branchId:branch.id,supplierId:supplier,clientOperationId:randomUUID(),
    lines:[{itemId:item.id,quantity:'2',unitCost:'2.00'}]},
    {method:'CASH',amount:'4.00',cashSessionId:session.id,deviceId:device.id},randomUUID());
  const expenses=new ExpenseOperationsService(tx);
  const expense=await expenses.create(context,{branchId:branch.id,categoryId:category,concept:'Monetary expense',amount:'2.00',
    method:'CASH',cashSessionId:session.id,deviceId:device.id},randomUUID());
  const compensation={reason:'Error de carga',cashSessionId:session.id,deviceId:device.id};
  const cancellationKey=randomUUID();
  const cancelled=await sales.cancel(context,sale.id,compensation,cancellationKey);
  expect(await sales.cancel(context,sale.id,compensation,cancellationKey)).toEqual(cancelled);
  await expect(tx.runWithOptionalAudit(context,async client=>({result:await client.query(
    'SELECT inventory_api.reverse_sale_stock($1,$2,$3,$4)',[randomUUID(),sale.id,cancelled.id,actor])})))
    .rejects.toMatchObject({code:'42501'});
  await expect(tx.runWithOptionalAudit(context,async client => ({result:await client.query('UPDATE sales SET id=id WHERE id=$1',[sale.id])})))
    .rejects.toMatchObject({code:'55000'});
  await expect(tx.runWithOptionalAudit(context,async client => ({result:await client.query('UPDATE sales SET total=0 WHERE id=$1',[sale.id])})))
    .rejects.toMatchObject({code:'42501'});
  await purchases.cancel(context,purchase.id,compensation,randomUUID());
  await expenses.cancel(context,expense.id,compensation,randomUUID());
  for (const [table,column] of [['catalog_price_versions','currency'],['sales','currency_code'],['sale_items','currency_code'],
    ['sale_payments','currency_code'],['sale_refunds','currency_code'],['purchases','currency_code'],['purchase_items','currency_code'],
    ['purchase_payments','currency_code'],['purchase_payment_reversals','currency_code'],['expenses','currency_code'],
    ['cash_sessions','currency_code'],['cash_movements','currency_code']] as const) {
    const result=await admin.query<{currency:string}>(`SELECT DISTINCT ${column} AS currency FROM ${table} WHERE organization_id=$1`,[organizationId]);
    expect(result.rows,table).toEqual([{currency}]);
  }
  expect((await admin.query('SELECT amount::text FROM sale_refunds WHERE sale_id=$1',[sale.id])).rows).toEqual([{amount:'3.00'}]);
  expect((await admin.query('SELECT amount::text FROM purchase_payment_reversals WHERE purchase_id=$1',[purchase.id])).rows).toEqual([{amount:'4.00'}]);
  expect((await admin.query(`SELECT source_type,delta::text,effect_kind FROM cash_movements WHERE cash_session_id=$1
    AND source_type IN ('SALE_CANCELLATION','PURCHASE_CANCELLATION','EXPENSE_CANCELLATION') ORDER BY source_type`,[session.id])).rows).toEqual([
    {source_type:'EXPENSE_CANCELLATION',delta:'2.00',effect_kind:'IN'},
    {source_type:'PURCHASE_CANCELLATION',delta:'4.00',effect_kind:'IN'},
    {source_type:'SALE_CANCELLATION',delta:'-3.00',effect_kind:'OUT'},
  ]);
  expect((await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id=$1',[session.id])).rows).toEqual([{expected_cash:'105.00'}]);
  expect((await admin.query('SELECT quantity::text FROM branch_stocks WHERE organization_id=$1 AND branch_id=$2 AND item_id=$3',
    [organizationId,branch.id,item.id])).rows).toEqual([{quantity:'5.000'}]);
  // The same global actor cannot use a monetary resource from a different tenant.
  await expect(sales.receipt({...context,organizationId:randomUUID()},sale.id)).resolves.toBeNull();
  const history = async () => Promise.all(['sales','sale_items','purchases','purchase_items',
    'inventory_movements','cash_movements','branch_stocks'].map(async table =>
    (await admin.query(`SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY ${table === 'branch_stocks' ? 'branch_id,item_id' : 'id'}`,[organizationId])).rows));
  // RF-56: deactivate after real business history; rejected commands must leave it intact.
  await new CatalogItemLifecycleService(tx).changeStatus(context,item.id,price.version,'INACTIVE',randomUUID());
  const before = await history();
  await expect(sales.confirm(context,{branchId:branch.id,cashSessionId:session.id,deviceId:device.id,
    clientOperationId:randomUUID(),lines,quoteFingerprint:quote.quoteFingerprint,
    payments:[{method:'CASH',appliedAmount:'3.00',receivedAmount:'3.00'}]},randomUUID())).rejects.toThrow();
  await expect(purchases.confirmPending(context,{branchId:branch.id,supplierId:supplier,clientOperationId:randomUUID(),
    lines:[{itemId:item.id,quantity:'1',unitCost:'2.00'}]},randomUUID())).rejects.toThrow();
  await expect(new InventoryAdjustmentService(tx).confirm(context,{branchId:branch.id,itemId:item.id,
    direction:'INCREASE',quantity:'1',reason:'CORRECCION'},randomUUID())).rejects.toThrow();
  expect(await history()).toEqual(before);
});
