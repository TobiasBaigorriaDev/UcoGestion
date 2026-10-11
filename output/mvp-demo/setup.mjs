import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const base = new URL('../../apps/api/dist/', import.meta.url);
const load = path => import(new URL(path, base));
const { runMigrations } = await load('database/migrate.js');
const { createGlobalUser } = await load('modules/auth/global-user.repository.js');
const { TenantTransaction } = await load('database/tenant-transaction.js');
const { PlatformDatabase } = await load('modules/platform-admin/platform-database.js');
const { PlatformProvisioningService } = await load('modules/platform-admin/platform-provisioning.service.js');
const adminUrl = 'postgresql://uconext_development:uconext_development@127.0.0.1:55432/postgres';
const database = 'uconext_small_business_demo';
const admin = new Pool({ connectionString: adminUrl });
if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount) await admin.query(`CREATE DATABASE ${database}`);
await admin.end();
const migrationUrl = adminUrl.replace('/postgres', '/' + database);
await runMigrations(migrationUrl);
const pool = new Pool({ connectionString: migrationUrl });
if ((await pool.query('SELECT 1 FROM organizations')).rowCount) throw new Error('La base ya tiene datos. No se sobrescriben; usar start.mjs.');
const runtimePassword = randomBytes(24).toString('hex');
await pool.query(`CREATE ROLE uco_demo_runtime LOGIN PASSWORD '${runtimePassword}' IN ROLE uco_app`);
const runtimeUrl = new URL(migrationUrl); runtimeUrl.username = 'uco_demo_runtime'; runtimeUrl.password = runtimePassword;
const platform = await createGlobalUser(pool, { email: 'setup@uco-demo.test', password: randomBytes(24).toString('hex') });
await pool.query("INSERT INTO platform_admins(user_id,status) VALUES($1,'ACTIVE')", [platform.id]);
const platformDb = new PlatformDatabase({ connectionString: migrationUrl });
const result = await new PlatformProvisioningService(platformDb).execute(platform.id, {
  requestId: 'small-business-demo-v1', organizationName: 'Almacén Don Pedro',
  firstBranchName: 'Local principal', timezone: 'America/Argentina/Buenos_Aires',
  ownerEmail: 'dueno@uco-demo.test', ownerPassword: 'DuenoPrueba2026!',
});
await platformDb.close();
const employee = await createGlobalUser(pool, { email: 'atencion@uco-demo.test', password: 'AtencionPrueba2026!' });
const membership = randomUUID();
await pool.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'ADMIN')", [membership,result.organizationId,employee.id]);
await pool.query('INSERT INTO membership_branches(organization_id,membership_id,branch_id) VALUES($1,$2,$3)', [result.organizationId,membership,result.branchId]);
const runtime = new Pool({ connectionString: runtimeUrl.toString() });
const transactions = new TenantTransaction(runtime);
const context = { organizationId: result.organizationId, userId: result.userId, requestId: randomUUID() };
const { CashRegisterManagementService } = await load('modules/branches/cash-register-management.service.js');
const register = await new CashRegisterManagementService(transactions).create(context, { branchId: result.branchId, name: 'Caja mostrador' });
const { CatalogCategoryManagementService } = await load('modules/catalog/catalog-category-management.service.js');
const categories = new CatalogCategoryManagementService(transactions);
const foods = await categories.create(context, { name: 'Almacén' }, 'demo-category-food');
const drinks = await categories.create(context, { name: 'Bebidas' }, 'demo-category-drinks');
const cleaning = await categories.create(context, { name: 'Limpieza' }, 'demo-category-cleaning');
const { CatalogItemCreationService } = await load('modules/catalog/catalog-item-creation.service.js');
const { CatalogPriceService } = await load('modules/catalog/catalog-price.service.js');
const { InventoryAdjustmentService } = await load('modules/inventory/inventory-adjustment.service.js');
const items = new CatalogItemCreationService(transactions), prices = new CatalogPriceService(transactions), stock = new InventoryAdjustmentService(transactions);
const products = [
 ['Yerba mate 1 kg','YERBA-1KG','4500.00','30',foods.id],
 ['Azúcar 1 kg','AZUCAR-1KG','1400.00','40',foods.id],
 ['Arroz 1 kg','ARROZ-1KG','1800.00','35',foods.id],
 ['Fideos 500 g','FIDEOS-500','1200.00','50',foods.id],
 ['Aceite 900 ml','ACEITE-900','2600.00','25',foods.id],
 ['Galletitas 250 g','GALLETAS-250','1500.00','45',foods.id],
 ['Leche 1 litro','LECHE-1L','1700.00','30',foods.id],
 ['Agua mineral 1.5 litros','AGUA-1500','1300.00','48',drinks.id],
 ['Gaseosa 2.25 litros','GASEOSA-2250','3200.00','24',drinks.id],
 ['Detergente 500 ml','DETERGENTE-500','1600.00','20',cleaning.id],
 ['Lavandina 1 litro','LAVANDINA-1L','1100.00','20',cleaning.id],
 ['Queso cremoso por kg','QUESO-KG','8500.00','12.500',foods.id,'FRACTIONAL'],
];
for (const [name,sku,price,quantity,categoryId,baseUnit='UNIT'] of products) {
 const item = await items.createIdempotent(context, { name,sku,type:'PRODUCT',trackInventory:true,baseUnit,categoryId }, 'demo-item-' + sku);
 await prices.setPrice(context,item.id,item.version,price);
 await stock.confirm(context,{branchId:result.branchId,itemId:item.id,direction:'INCREASE',quantity,reason:'INVENTARIO_INICIAL',observation:'Mercadería inicial del escenario de prueba'},'demo-stock-' + sku);
}
const { ExpenseCategoryManagementService } = await load('modules/expenses/expense-category-management.service.js');
const expenseCategories = new ExpenseCategoryManagementService(transactions);
await expenseCategories.create(context,{name:'Servicios'},'demo-expense-services');
await expenseCategories.create(context,{name:'Gastos del local'},'demo-expense-local');
const signer=generateKeyPairSync('ec',{namedCurve:'prime256v1'}), ingestion=generateKeyPairSync('rsa',{modulusLength:3072});
const environment = { DATABASE_URL:runtimeUrl.toString(), PORT:'4000',
 UCONEXT_PUBLIC_API_ORIGIN:'http://localhost:3000',UCONEXT_API_INTERNAL_ORIGIN:'http://localhost:4000',
 OFFLINE_SIGNING_PRIVATE_KEY:signer.privateKey.export({format:'pem',type:'pkcs8'}).toString(),OFFLINE_SIGNING_KEY_ID:'demo-signing-v1',
 OFFLINE_INGESTION_KEYS:JSON.stringify({activeKeyId:'demo-ingestion-v1',keys:{'demo-ingestion-v1':ingestion.privateKey.export({format:'pem',type:'pkcs8'}).toString()}}),
 DEVICE_CERTIFICATE_KEY:randomBytes(32).toString('base64url'),RATE_LIMIT_PEPPER:randomBytes(32).toString('hex') };
await writeFile(new URL('.env.local',import.meta.url),Object.entries(environment).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n'));
await writeFile(new URL('scenario.json',import.meta.url),JSON.stringify({...result,employeeId:employee.id,cashRegisterId:register.id,products:products.length},null,2));
await runtime.end(); await pool.end();
console.log('Escenario listo: una organización, una sucursal, dos operadores, una caja y 12 productos.');
