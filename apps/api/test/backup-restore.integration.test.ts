import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrate.js';
import { publishBackup, downloadBackup } from '../src/operations/backup.js';
import { checkRecoveredDatabase, prepareEmptyRestore, restoreIdentityDispatcherOwnership } from '../src/operations/restore.js';
import { runRecoverySmoke } from '../src/operations/recovery-smoke.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { BranchManagementService } from '../src/modules/branches/branch-management.service.js';
import { CatalogItemCreationService } from '../src/modules/catalog/catalog-item-creation.service.js';
import { InventoryIncreaseService } from '../src/modules/inventory/inventory-increase.service.js';

const execute = promisify(execFile);
it('T231/T232 restores an authenticated pg_dump with historical keys, grants, migrations and ledger checks', async () => {
  const source=await new PostgreSqlContainer('postgres:16-alpine').start();
  const target=await new PostgreSqlContainer('postgres:16-alpine').withDatabase('uco_restore_drill').start();
  const sourcePool=new Pool({connectionString:source.getConnectionUri()}), targetPool=new Pool({connectionString:target.getConnectionUri()});
  const directory=await mkdtemp(join(tmpdir(),'uco-drill-')), destination=await mkdtemp(join(tmpdir(),'uco-recovered-'));
  const storeObjects=new Map<string,Buffer>();
  const store={put:async(name:string,path:string)=>{storeObjects.set(name,await readFile(path));},
    get:async(name:string,path:string)=>{const bytes=storeObjects.get(name);if(!bytes)throw new Error('missing');await writeFile(path,bytes);}};
  const client=await targetPool.connect();
  try {
    await runMigrations(source.getConnectionUri());
    const rsa=generateKeyPairSync('rsa',{modulusLength:3072}), ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const privatePem=(key:typeof ec.privateKey)=>key.export({format:'pem',type:'pkcs8'}).toString();
    const publicPem=(key:typeof ec.publicKey)=>key.export({format:'pem',type:'spki'}).toString();
    const environment={OFFLINE_SIGNING_KEY_ID:'historical',OFFLINE_SIGNING_PRIVATE_KEY:privatePem(ec.privateKey),
      OFFLINE_INGESTION_KEYS:JSON.stringify({activeKeyId:'old',keys:{old:privatePem(rsa.privateKey)}}),OFFLINE_ACK_SIGNING_KEYS:'{}',DEVICE_CERTIFICATE_KEY:randomBytes(32).toString('base64url')};
    const org=randomUUID();
    await sourcePool.query("INSERT INTO organizations(id,name,base_currency,timezone) VALUES($1,'Recovered organization','ARS','UTC')",[org]);
    const user=randomUUID();
    await sourcePool.query("INSERT INTO users(id,email_normalized,password_hash,password_hash_version) VALUES($1,'restore-owner@example.com','$argon2id$v=19$test',1)",[user]);
    await sourcePool.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'OWNER')",[randomUUID(),org,user]);
    const transactions=new TenantTransaction(sourcePool), context={organizationId:org,userId:user,requestId:randomUUID()};
    const branch=await new BranchManagementService(transactions).create(context,{name:'Restore stock'});
    const item=await new CatalogItemCreationService(transactions).create(context,{name:'Restored product',type:'PRODUCT',trackInventory:true,baseUnit:'FRACTIONAL'});
    await new InventoryIncreaseService(transactions).confirm(context,{branchId:branch.id,itemId:item.id,quantity:'7.125',reason:'INVENTARIO_INICIAL'},randomUUID());
    const register=randomUUID(), device=randomUUID(), session=randomUUID();
    await sourcePool.query("INSERT INTO cash_registers(id,organization_id,branch_id,name) VALUES($1,$2,$3,'Restored register')",[register,org,branch.id]);
    await sourcePool.query("INSERT INTO devices(id,organization_id,branch_id,authorized_by_user_id,authorized_at,status) VALUES($1,$2,$3,$4,now(),'ACTIVE')",[device,org,branch.id,user]);
    await sourcePool.query(`INSERT INTO cash_sessions(id,organization_id,branch_id,cash_register_id,owner_user_id,device_id,origin,status,opening_cash,expected_cash,currency_code)
      VALUES($1,$2,$3,$4,$5,$6,'ONLINE','OPEN',10,10,'ARS')`,[session,org,branch.id,register,user,device]);
    await sourcePool.query(`INSERT INTO cash_movements(id,organization_id,branch_id,cash_session_id,actor_user_id,device_id,delta,currency_code,source_type,source_id,effect_kind)
      VALUES($1,$2,$3,$4,$5,$6,5,'ARS','MANUAL',$7,'IN')`,[randomUUID(),org,branch.id,session,user,device,randomUUID()]);
    await sourcePool.query('INSERT INTO offline_ingestion_key_registry(key_id,public_key_pem) VALUES($1,$2)',['old',publicPem(rsa.publicKey)]);
    await sourcePool.query("INSERT INTO configuration_versions(id,organization_id,version,snapshot,canonical_payload,signature,signing_key_id,public_key_pem) VALUES($1,$2,1,'{}','{}','test','historical',$3)",[randomUUID(),org,publicPem(ec.publicKey)]);
    await execute('docker',['exec',source.getId(),'pg_dump','-U','test','-d','test','--format=custom','--no-owner','--file=/tmp/drill.dump']);
    await execute('docker',['cp',`${source.getId()}:/tmp/drill.dump`,join(directory,'database.dump')]);
    const key=randomBytes(32);
    const manifest=await publishBackup(directory,join(directory,'database.dump'),environment,key,'vault/v1',new Date().toISOString(),store);
    const recovered=await downloadBackup(destination,manifest.id,key,store);
    await prepareEmptyRestore(client);
    await execute('docker',['cp',join(destination,'database.dump'),`${target.getId()}:/tmp/drill.dump`]);
    await execute('docker',['exec',target.getId(),'pg_restore','-U','test','-d','uco_restore_drill','--exit-on-error','--single-transaction','--no-owner','/tmp/drill.dump']);
    await runMigrations(target.getConnectionUri());
    await restoreIdentityDispatcherOwnership(client);
    expect((await client.query(`SELECT r.rolname,r.rolsuper,r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid='claim_identity_email_jobs(integer,integer)'::regprocedure`)).rows).toEqual([
      {rolname:'uco_identity_dispatcher',rolsuper:false,rolbypassrls:false},
    ]);
    await client.query('SET ROLE uco_worker');
    expect((await client.query('SELECT * FROM claim_identity_email_jobs(1,30)')).rows).toEqual([]);
    await client.query('RESET ROLE');
    expect((await client.query('SELECT name FROM organizations')).rows).toEqual([{name:'Recovered organization'}]);
    await expect(checkRecoveredDatabase(client,recovered.environment)).resolves.toBeUndefined();
    expect((await client.query('SELECT quantity FROM branch_stocks WHERE item_id=$1',[item.id])).rows[0]?.quantity).toBe('7.125');
    expect((await client.query('SELECT expected_cash FROM cash_sessions WHERE id=$1',[session])).rows[0]?.expected_cash).toBe('15.00');
    await runRecoverySmoke(target.getConnectionUri(),recovered.environment);
    const missing={...recovered.environment,OFFLINE_INGESTION_KEYS:JSON.stringify({activeKeyId:'new',keys:{new:privatePem(rsa.privateKey)}})};
    await expect(checkRecoveredDatabase(client,missing)).rejects.toThrow(/unavailable/);
    await client.query('UPDATE branch_stocks SET quantity=8.125 WHERE item_id=$1',[item.id]);
    await expect(checkRecoveredDatabase(client,recovered.environment)).rejects.toThrow(/ledger/);
    expect((await client.query('SELECT quantity FROM branch_stocks WHERE item_id=$1',[item.id])).rows[0]?.quantity).toBe('8.125');
    await client.query('UPDATE branch_stocks SET quantity=7.125 WHERE item_id=$1',[item.id]);
    // Disaster corruption is injected by the isolated administrator; runtime cannot rewrite cash history.
    await client.query('ALTER TABLE cash_sessions DISABLE TRIGGER USER');
    await client.query('UPDATE cash_sessions SET expected_cash=16 WHERE id=$1',[session]);
    await client.query('ALTER TABLE cash_sessions ENABLE TRIGGER USER');
    await expect(checkRecoveredDatabase(client,recovered.environment)).rejects.toThrow(/ledger/);
    await client.query('ALTER TABLE cash_sessions DISABLE TRIGGER USER');
    await client.query('UPDATE cash_sessions SET expected_cash=15 WHERE id=$1',[session]);
    await client.query('ALTER TABLE cash_sessions ENABLE TRIGGER USER');
    await client.query("ALTER TABLE branch_stocks DISABLE ROW LEVEL SECURITY");
    await expect(checkRecoveredDatabase(client,recovered.environment)).rejects.toThrow(/RLS/);
  } finally {client.release();await sourcePool.end();await targetPool.end();await source.stop();await target.stop();await rm(directory,{recursive:true,force:true});await rm(destination,{recursive:true,force:true});}
});
