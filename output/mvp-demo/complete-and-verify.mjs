import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const base = new URL('../../apps/api/dist/', import.meta.url);
const { TenantTransaction } = await import(new URL('database/tenant-transaction.js',base));
const environment = {};
for (const line of (await readFile(new URL('.env.local',import.meta.url),'utf8')).split('\n')) {
 if (!line) continue; const split=line.indexOf('='); environment[line.slice(0,split)]=JSON.parse(line.slice(split+1));
}
const scenario=JSON.parse(await readFile(new URL('scenario.json',import.meta.url),'utf8'));
const pool = new Pool({connectionString:environment.DATABASE_URL});
const transactions=new TenantTransaction(pool);
const context={organizationId:scenario.organizationId,userId:scenario.userId,requestId:randomUUID()};
const { CustomerManagementService } = await import(new URL('modules/customers/customer-management.service.js',base));
const { SupplierManagementService } = await import(new URL('modules/suppliers/supplier-management.service.js',base));
await new CustomerManagementService(transactions).create(context,{name:'María López',notes:'Cliente ficticio para pruebas'},'demo-customer-maria');
await new SupplierManagementService(transactions).create(context,{name:'Distribuidora de prueba',notes:'Proveedor ficticio para pruebas'},'demo-supplier');
await transactions.read(context,async client=>{
 assert.equal((await client.query('SELECT 1 FROM branches')).rowCount,1);
 assert.equal((await client.query('SELECT 1 FROM memberships')).rowCount,2);
 assert.equal((await client.query('SELECT 1 FROM catalog_items')).rowCount,12);
 assert.equal((await client.query('SELECT 1 FROM branch_stocks WHERE quantity > 0')).rowCount,12);
 const difference=await client.query(`SELECT s.item_id FROM branch_stocks s LEFT JOIN
 (SELECT organization_id,branch_id,item_id,sum(delta) AS total FROM inventory_movements GROUP BY organization_id,branch_id,item_id) m
 USING(organization_id,branch_id,item_id) WHERE s.quantity IS DISTINCT FROM coalesce(m.total,0)`);
 assert.equal(difference.rowCount,0,'Stock debe coincidir con el ledger');
 assert.equal((await client.query("SELECT 1 FROM audit_events WHERE action='catalog_item.created'")).rowCount,12);
});
const client=await pool.connect();
await client.query('BEGIN');
await client.query("SELECT set_config('app.organization_id',$1,true)",[randomUUID()]);
assert.equal((await client.query('SELECT 1 FROM catalog_items')).rowCount,0,'RLS debe impedir lectura ajena');
await client.query('ROLLBACK'); client.release();
await pool.end();
assert.equal((await fetch('http://localhost:4000/api/v1/health/ready')).status,200);
console.log('PASS: escenario, stock/ledger, auditoría, aislamiento RLS y API readiness.');
