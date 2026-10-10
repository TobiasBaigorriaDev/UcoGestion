import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Network, Wait, type StartedTestContainer } from 'testcontainers';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { ReportExportService, ReportsService } from '../src/modules/reports/index.js';
import { S3ObjectStorage } from '../src/core/objects/s3-object-storage.js';
import { InvitationCreationService } from '../src/modules/users/invitation-creation.service.js';
import { PasswordResetRequestService } from '../src/modules/auth/password-reset-request.service.js';
import { PostgresRateLimitService } from '../src/modules/auth/postgres-rate-limit.service.js';

// The gateway is the external email port; the unchanged built worker runs in this process.
const emailGatewayFixture = `const http=require('http');const messages=new Map();
http.createServer(async(req,res)=>{
 if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify([...messages.values()]));return;}
 if(req.headers.authorization!=='Bearer smoke'){res.statusCode=401;res.end();return;}
 let body='';for await(const chunk of req)body+=chunk;
 messages.set(req.headers['idempotency-key'],JSON.parse(body));res.statusCode=204;res.end();
}).listen(9001,'0.0.0.0',()=>import('/app/apps/api/dist/worker.js'));`;

// S3 is an external port; this local HTTP fixture never substitutes for PostgreSQL or the worker.
const s3Fixture=`const http=require('http');const objects=new Map();http.createServer(async(req,res)=>{
 const key=req.url.split('?')[0];const chunks=[];for await(const chunk of req)chunks.push(chunk);
 if(req.method==='PUT'){objects.set(key,Buffer.concat(chunks));res.setHeader('ETag','"smoke"');res.end();return;}
 if(req.method==='DELETE'){objects.delete(key);res.end();return;}
 if(req.method==='HEAD'){res.end();return;}
 const body=objects.get(key);if(!body){res.statusCode=404;res.end();return;}
 res.setHeader('Content-Length',body.length);res.setHeader('Content-Type','application/pdf');res.end(body);
 }).listen(9000,'0.0.0.0');`;

it('T235 runs built web/API/worker images and generates a downloadable PDF through the real outbox', async () => {
  const network=await new Network().start();
  const database=await new PostgreSqlContainer('postgres:16-alpine').withNetwork(network).withNetworkAliases('db').start();
  const pool=new Pool({connectionString:database.getConnectionUri()});
  const started: StartedTestContainer[]=[];
  let runtime:Pool|undefined;
  try {
    await runMigrations(database.getConnectionUri());
    await pool.query("CREATE ROLE delivery_runtime LOGIN PASSWORD 'smoke' IN ROLE uco_app");
    await pool.query("CREATE ROLE delivery_dispatch LOGIN PASSWORD 'smoke' IN ROLE uco_worker");
    const org=randomUUID(),user=randomUUID();
    await pool.query("INSERT INTO organizations(id,name,base_currency,timezone) VALUES($1,'Delivery smoke','ARS','UTC')",[org]);
    await pool.query("INSERT INTO users(id,email_normalized,password_hash,password_hash_version) VALUES($1,'delivery@example.com','$argon2id$v=19$smoke',1)",[user]);
    await pool.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'OWNER')",[randomUUID(),org,user]);
    const s3=await new GenericContainer('node:24.15.0-bookworm-slim').withNetwork(network).withNetworkAliases('s3')
      .withCommand(['node','-e',s3Fixture]).withExposedPorts(9000).withWaitStrategy(Wait.forListeningPorts()).start();started.push(s3);
    const endpoint=`http://${s3.getHost()}:${s3.getMappedPort(9000)}`;
    const storage=new S3ObjectStorage({endpoint,bucket:'smoke',region:'us-east-1',accessKeyId:'smoke',secretAccessKey:'smoke'});
    const client=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'smoke',secretAccessKey:'smoke'}});
    await client.send(new CreateBucketCommand({Bucket:'smoke'}));
    const environment={DATABASE_URL:'postgresql://delivery_runtime:smoke@db:5432/test',
      WORKER_DISPATCH_DATABASE_URL:'postgresql://delivery_dispatch:smoke@db:5432/test',WORKER_USER_ID:user,
      UCONEXT_PUBLIC_API_ORIGIN:'http://localhost:3000',S3_ENDPOINT:'http://s3:9000',S3_BUCKET:'smoke',S3_REGION:'us-east-1',
      S3_ACCESS_KEY_ID:'smoke',S3_SECRET_ACCESS_KEY:'smoke'};
    const workerEnvironment = { ...environment, EMAIL_GATEWAY_URL: 'http://127.0.0.1:9001', EMAIL_GATEWAY_TOKEN: 'smoke' };
    const api=await new GenericContainer('uconext-api:operations').withNetwork(network).withEnvironment(environment)
      .withExposedPorts(3000).withWaitStrategy(Wait.forHttp('/api/v1/health/ready',3000)).start();started.push(api);
    const web=await new GenericContainer('uconext-web:operations').withNetwork(network)
      .withExposedPorts(3000).withWaitStrategy(Wait.forHttp('/',3000)).start();started.push(web);
    const worker=await new GenericContainer('uconext-worker:operations').withNetwork(network).withEnvironment(workerEnvironment)
      .withCopyContentToContainer([{ content: emailGatewayFixture, target: '/tmp/email-gateway.cjs' }])
      .withCommand(['node','/tmp/email-gateway.cjs'])
      .withExposedPorts(3001,9001).withWaitStrategy(Wait.forHttp('/health/ready',3001)).start();started.push(worker);
    const apiOrigin=`http://${api.getHost()}:${api.getMappedPort(3000)}`,webOrigin=`http://${web.getHost()}:${web.getMappedPort(3000)}`;
    for(const path of ['/api/v1','/api/v1/health/live','/api/v1/health/ready','/api/v1/metrics'])expect((await fetch(apiOrigin+path)).status).toBe(200);
    for(const path of ['/','/manifest.webmanifest','/sw.js','/icon-192.png','/icon-512.png']) {
      const response=await fetch(webOrigin+path);expect(response.status,path).toBe(200);expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    expect((await fetch(apiOrigin+'/api/v1/reports/sales')).status).toBe(401);
    const runtimeUrl=new URL(database.getConnectionUri());runtimeUrl.username='delivery_runtime';runtimeUrl.password='smoke';
    runtime=new Pool({connectionString:runtimeUrl.toString()});
    const transactions=new TenantTransaction(runtime),exports=new ReportExportService(transactions,new ReportsService(transactions),storage);
    const context={organizationId:org,userId:user,requestId:randomUUID()};
    const queued=await exports.queue(context,'sales',{limit:100},randomUUID());
    await expect.poll(async()=>(await exports.get(context,queued.id)).status,{timeout:30000,interval:500}).toBe('READY');
    const object=await client.send(new GetObjectCommand({Bucket:'smoke',Key:`exports/${org}/${queued.id}`}));
    expect(Buffer.from(await object.Body?.transformToByteArray() ?? []).subarray(0,5).toString()).toBe('%PDF-');
    expect((await pool.query("SELECT 1 FROM audit_events WHERE organization_id=$1 AND action='outbox.processed'",[org])).rowCount).toBe(1);
    const state=await pool.query('SELECT status FROM outbox_jobs WHERE organization_id=$1 AND job_key=$2',[org,`report-pdf:${queued.id}`]);
    expect(state.rows[0]?.status).toBe('COMPLETED');
    const reset = new PasswordResetRequestService(runtime, new PostgresRateLimitService(runtime,
      { pepper: 'delivery-smoke-pepper', windowSeconds: 300, limits: { LOGIN: 10, PASSWORD_RESET: 10, INVITATION: 10 } }));
    await reset.execute({ email: 'delivery@example.com', ipAddress: '127.0.0.1' });
    const invitation = await new InvitationCreationService(transactions).create(context,
      { email: 'invited@example.com', role: 'OWNER', branchIds: [] });
    const gatewayOrigin = `http://${worker.getHost()}:${worker.getMappedPort(9001)}`;
    await expect.poll(async () => (await (await fetch(gatewayOrigin)).json() as unknown[]).length,
      { timeout: 30000, interval: 500 }).toBe(2);
    const messages: unknown = await (await fetch(gatewayOrigin)).json();
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ template: 'PASSWORD_RESET', email: 'delivery@example.com', token: expect.any(String) }),
      expect.objectContaining({ template: 'INVITATION', email: 'invited@example.com', role: 'OWNER', branchIds: [] }),
    ]));
    await pool.query(`UPDATE invitations SET created_at='2020-01-01',expires_at='2020-01-08' WHERE id=$1`, [invitation.invitationId]);
    await pool.query(`UPDATE outbox_jobs SET available_at='2020-01-08',
      payload=jsonb_set(payload,'{expiresAt}','"2020-01-08T00:00:00.000Z"')
      WHERE job_type='INVITATION_EXPIRATION' AND payload->>'invitationId'=$1`, [invitation.invitationId]);
    await expect.poll(async () => (await pool.query('SELECT status FROM invitations WHERE id=$1', [invitation.invitationId])).rows[0]?.status,
      { timeout: 30000, interval: 500 }).toBe('EXPIRED');
    expect((await pool.query("SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='invitation.expired'", [invitation.invitationId])).rowCount).toBe(1);
    client.destroy();
  } finally {
    await runtime?.end();await pool.end();
    for(const container of started.reverse())await container.stop();
    await database.stop();await network.stop();
  }
},120000);
