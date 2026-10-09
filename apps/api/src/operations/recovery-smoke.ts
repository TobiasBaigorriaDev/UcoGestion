import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { AppModule } from '../app.module.js';
import { configureApi } from '../configure-api.js';
import type { ObjectStoragePort } from '../core/objects/object-storage.port.js';
import { OutboxDispatcher, OutboxWorker } from '../core/outbox/outbox-worker.js';
import { TenantTransaction } from '../database/tenant-transaction.js';
import { ReportExportService, ReportsService } from '../modules/reports/index.js';

/** Canary operations are only permitted in the disposable recovered database. */
export async function runRecoverySmoke(connection: string, custody: NodeJS.ProcessEnv): Promise<void> {
  if (!new URL(connection).pathname.startsWith('/uco_restore_')) throw new Error('Recovery smoke requires a disposable database.');
  const admin = new Pool({connectionString:connection}), password=randomBytes(24).toString('hex');
  const role=`drill_${randomBytes(8).toString('hex')}`, dispatcherRole=`${role}_dispatch`;
  const directory=await mkdtemp(join(tmpdir(),'uco-smoke-'));
  const previous={...process.env};
  let runtime: Pool | undefined, dispatch: Pool | undefined;
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  try {
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' IN ROLE uco_app`);
    await admin.query(`CREATE ROLE ${dispatcherRole} LOGIN PASSWORD '${password}' IN ROLE uco_outbox_dispatcher`);
    const runtimeUrl=new URL(connection); runtimeUrl.username=role; runtimeUrl.password=password;
    const dispatchUrl=new URL(runtimeUrl); dispatchUrl.username=dispatcherRole;
    runtime=new Pool({connectionString:runtimeUrl.toString()}); dispatch=new Pool({connectionString:dispatchUrl.toString()});
    const organizationId=randomUUID(), userId=randomUUID();
    await admin.query("INSERT INTO organizations(id,name,base_currency,timezone) VALUES($1,'Restore smoke','ARS','UTC')",[organizationId]);
    await admin.query("INSERT INTO users(id,email_normalized,password_hash,password_hash_version) VALUES($1,$2,'$argon2id$v=19$smoke',1)",[userId,`${userId}@restore.invalid`]);
    await admin.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'OWNER')",[randomUUID(),organizationId,userId]);
    const files=new Map<string,string>();
    const storage: ObjectStoragePort={
      put:async(key,bytes)=>{const path=join(directory,randomUUID());await writeFile(path,bytes,{mode:0o600});files.set(key,path);},
      delete:async(key)=>{const path=files.get(key);if(path)await rm(path,{force:true});},
      signedGetUrl:async(key)=>{const path=files.get(key);if(!path)throw new Error('Smoke file missing');return path;},
    };
    const transactions=new TenantTransaction(runtime), reports=new ReportExportService(transactions,new ReportsService(transactions),storage);
    const context={organizationId,userId,requestId:randomUUID()};
    const queued=await reports.queue(context,'sales',{limit:100},randomUUID());
    const dispatcher=new OutboxDispatcher(dispatch,'REPORT_ARTIFACTS');
    const worker=new OutboxWorker({dispatcher,tenantTransactions:transactions,workerUserId:userId,maxAttempts:5,retryBaseSeconds:2,
      authorizer:{authorize:async(job)=>{if(job.organizationId!==organizationId)throw new Error('Only drill canary jobs allowed');}},
      handlers:{REPORT_PDF:(job,client)=>reports.handle(job,client)}});
    // Restored production jobs stay untouched: claim only the newly-created canary.
    const job=(await admin.query<{id:string}>('SELECT id FROM outbox_jobs WHERE organization_id=$1 AND payload->>\'exportId\'=$2',[organizationId,queued.id])).rows[0];
    if(!job)throw new Error('Smoke outbox missing');
    const lease=randomUUID();
    await admin.query("UPDATE outbox_jobs SET status='PROCESSING',lease_id=$2,lease_expires_at=now()+interval '5 minutes',attempt_count=1 WHERE id=$1",[job.id,lease]);
    const result=await worker.process({jobId:job.id,jobType:'REPORT_PDF',leaseId:lease,organizationId});
    if(result.status!=='COMPLETED')throw new Error('Recovered worker failed');
    const exported=await reports.get(context,queued.id);
    if(exported.status!=='READY'||!exported.url||(await readFile(exported.url)).subarray(0,5).toString()!=='%PDF-')throw new Error('Recovered file smoke failed');
    if(!(await admin.query("SELECT 1 FROM audit_events WHERE organization_id=$1 AND action='outbox.processed'",[organizationId])).rowCount)throw new Error('Worker audit missing');
    Object.assign(process.env,custody,{DATABASE_URL:runtimeUrl.toString(),UCONEXT_PUBLIC_API_ORIGIN:'http://127.0.0.1:3000'});
    delete process.env.OPERATIONS_MONITOR_CONTEXTS; delete process.env.INVENTORY_VERIFIER_CONTEXTS;
    app=configureApi(await NestFactory.create(AppModule,{logger:false}));
    await app.listen(0,'127.0.0.1');
    const origin=await app.getUrl();
    for(const path of ['/api/v1','/api/v1/health/live','/api/v1/health/ready','/api/v1/metrics']) {
      if((await fetch(`${origin}${path}`)).status!==200)throw new Error(`Recovered API smoke failed: ${path}`);
    }
    for(const path of ['/api/v1/reports/sales','/api/v1/sales/00000000-0000-4000-8000-000000000001/receipt.pdf']) {
      if((await fetch(`${origin}${path}`)).status!==401)throw new Error('Recovered private route protection failed');
    }
  } finally {
    await app?.close(); await runtime?.end(); await dispatch?.end(); await admin.end();
    for(const name of Object.keys(process.env)) if(!(name in previous))delete process.env[name];
    Object.assign(process.env,previous);
    await rm(directory,{recursive:true,force:true});
  }
}
