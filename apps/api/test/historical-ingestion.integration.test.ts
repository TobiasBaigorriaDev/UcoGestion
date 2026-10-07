import { createCipheriv, createHash, generateKeyPairSync, publicEncrypt, randomBytes, randomUUID, sign } from 'node:crypto';
import { offlineGrantProofPayload } from '@uconext/shared';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogPriceService } from '../src/modules/catalog/catalog-price.service.js';
import { InventoryIncidentService } from '../src/modules/inventory/inventory-incident.service.js';
import { InventoryAdjustmentService } from '../src/modules/inventory/inventory-adjustment.service.js';
import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { OfflineBootstrapService } from '../src/modules/offline-sync/offline-bootstrap.service.js';
import { OfflineGrantService } from '../src/modules/offline-sync/offline-grant.service.js';
import { RsaSyncEnvelopeDecryptor } from '../src/modules/offline-sync/sync-envelope-decryptor.js';
import { DeviceCertificate } from '../src/modules/offline-sync/device-certificate.js';
import { HistoricalEnvelopeValidator, canonicalEnvelopeJson } from '../src/modules/offline-sync/historical-envelope-validator.js';
import { recordRevocationCheckpoint, revocationCheckpointPayload, readRevocationKnowledge } from '../src/modules/offline-sync/revocation-checkpoint.js';
import { HistoricalDeliveryIngestion } from '../src/modules/offline-sync/historical-delivery-ingestion.js';

const ec = generateKeyPairSync('ec', { namedCurve:'prime256v1' });
const rsa = generateKeyPairSync('rsa', { modulusLength:3072 });
const publicKey = ec.publicKey.export({type:'spki',format:'pem'}).toString();
const certificates = new DeviceCertificate(randomBytes(32));
const item=randomUUID();
const org=randomUUID(), foreign=randomUUID(), actor=randomUUID(), branch=randomUUID(), device=randomUUID(), register=randomUUID();
const certificate=certificates.issue({organizationId:org,deviceId:device,thumbprint:certificates.thumbprint(publicKey)});
const claims=certificates.open(certificate);
const custody=new RsaSyncEnvelopeDecryptor({activeKeyId:'rsa',keys:{rsa:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()}},ec.privateKey,'trusted');
const signer={keyId:'trusted',publicKeyPem:publicKey,sign:(value:string)=>sign('sha256',Buffer.from(value),ec.privateKey).toString('base64')};
const context=()=>({organizationId:org,userId:actor,requestId:randomUUID()});
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('base64');
function seal(operation: Record<string,unknown>) {
  const routing={version:1,keyId:'rsa',operationId:operation.id,certificate};
  const payloadHash=sha(canonicalEnvelopeJson(operation));
  const signature=sign('sha256',Buffer.from(payloadHash,'base64'),{key:ec.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
  const cek=randomBytes(32), iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',cek,iv);
  cipher.setAAD(Buffer.from(canonicalEnvelopeJson(routing)));
  const ciphertext=Buffer.concat([cipher.update(canonicalEnvelopeJson({routing,operation,payloadHash,signature})),cipher.final(),cipher.getAuthTag()]);
  const unsigned={...routing,iv:iv.toString('base64'),wrappedCek:publicEncrypt({key:rsa.publicKey,oaepHash:'sha256'},cek).toString('base64'),ciphertext:ciphertext.toString('base64'),ciphertextHash:sha(ciphertext)};
  return canonicalEnvelopeJson({...unsigned,signature:sign('sha256',Buffer.from(canonicalEnvelopeJson(unsigned)),{key:ec.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')});
}

describe('historical delivery transactions',()=>{
  let container:StartedPostgreSqlContainer, pool:Pool, runtime:Pool, transactions:TenantTransaction;
  let ingestion:HistoricalDeliveryIngestion;
  let operation:Record<string,unknown>, exact:string;
  beforeAll(async()=>{
    container=await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool=new Pool({connectionString:container.getConnectionUri()});
    await pool.query("CREATE ROLE ingestion_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url=new URL(container.getConnectionUri());url.username='ingestion_runtime';url.password='runtime-password';
    runtime=new Pool({connectionString:url.toString()});transactions=new TenantTransaction(runtime);
    await pool.query("INSERT INTO users (id,email_normalized,password_hash,password_hash_version) VALUES ($1,'ingest@example.com','$argon2id$v=19$test',1)",[actor]);
    await pool.query("INSERT INTO organizations (id,name,base_currency,timezone) VALUES ($1,'Main','ARS','UTC'),($2,'Foreign','ARS','UTC')",[org,foreign]);
    await pool.query("INSERT INTO memberships (id,organization_id,user_id,role) VALUES ($1,$2,$3,'OWNER')",[randomUUID(),org,actor]);
    await pool.query("INSERT INTO branches (id,organization_id,name) VALUES ($1,$2,'Main')",[branch,org]);
    await pool.query("INSERT INTO cash_registers (id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Main')",[register,org,branch]);
    await pool.query("INSERT INTO devices (id,organization_id,branch_id,authorized_by_user_id,authorized_at,status,public_key,public_key_thumbprint) VALUES ($1,$2,$3,$4,now(),'ACTIVE',$5,$6)",[device,org,branch,actor,publicKey,certificates.thumbprint(publicKey)]);
    await pool.query("INSERT INTO catalog_items (id,organization_id,name,type,base_unit,track_inventory,price,price_version) VALUES ($1,$2,'Original','PRODUCT','UNIT',true,10,1)",[item,org]);
    const bootstrap=await new OfflineBootstrapService(transactions,signer,custody).issue(context(),{deviceId:device,branchId:branch},'bootstrap');
    const parsed=JSON.parse(bootstrap.payload);
    const proofInput={grantId:parsed.grantId as string,bootstrapHash:createHash('sha256').update(bootstrap.payload).digest('hex'),deviceSequence:'0',headHash:null};
    const grant=(await new OfflineGrantService(transactions,ec.privateKey,'trusted').issue(context(),{...proofInput,proof:sign('sha256',Buffer.from(offlineGrantProofPayload(proofInput)),{key:ec.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')},'grant')).grant;
    const session=randomUUID(), occurredAt=new Date().toISOString();
    operation={id:randomUUID(),actorId:actor,organizationId:org,deviceId:device,sessionId:session,sequence:'1',sessionSequence:'1',previousHash:null,kind:'cash-session-open',grant,configVersion:parsed.configurationVersion,occurredAt,receivedAt:null,payload:{id:session,actorUserId:actor,branchId:branch,cashRegisterId:register,openingCash:'10.00',currency:'ARS',openedAt:occurredAt,status:'OPEN'}};
    exact=seal(operation);
    ingestion=new HistoricalDeliveryIngestion(transactions,new HistoricalEnvelopeValidator(certificates,custody),()=>ec.privateKey);
  });
  afterAll(async()=>{await runtime?.end();await pool?.end();await container?.stop();});
  it('T201 imports once under original revoked actor scope and RLS with stable receipt',async()=>{
    await pool.query("UPDATE memberships SET status='REVOKED',revoked_at=now() WHERE organization_id=$1",[org]);
    const first=await ingestion.ingest(claims,exact);
    expect(first).toMatchObject({operationId:operation.id,status:'ACKED'});
    expect(await ingestion.ingest(claims,exact)).toEqual(first);
    expect((await pool.query('SELECT expected_cash FROM cash_sessions WHERE id=$1',[operation.sessionId])).rows[0]?.expected_cash).toBe('10.00');
    await expect(ingestion.ingest({...claims,organizationId:foreign},exact)).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::integer AS n FROM sync_operations')).rows[0]?.n).toBe(1);
    expect((await pool.query("SELECT count(*)::integer AS n FROM audit_events WHERE action='cash.session.opened.offline'")).rows[0]?.n).toBe(1);
  });
  it('T202 retries exact bytes concurrently and rejects resealing under the same operation ID',async()=>{
    const results=await Promise.all([ingestion.ingest(claims,exact),ingestion.ingest(claims,exact)]);
    expect(results[0]).toEqual(results[1]);
    await expect(ingestion.ingest(claims,seal(operation))).rejects.toThrow('SYNC_RECEIPT_CONFLICT');
    expect((await pool.query('SELECT count(*)::integer AS n FROM cash_sessions')).rows[0]?.n).toBe(1);
  });


  it('T209 imports historical sale, payments, receipt and negative stock incidence in the same transaction',async()=>{
    const id=randomUUID();const occurredAt=new Date().toISOString();
    const previousHash=sha(canonicalEnvelopeJson(operation));
    const payload={id,localReference:'LOCAL-2',reference:null,status:'CONFIRMED',requestHash:sha('request'),actorUserId:actor,
      deviceId:device,organizationId:org,branchId:branch,cashSessionId:operation.sessionId,customerId:null,customerKind:'CONSUMER_FINAL',
      configurationVersion:operation.configVersion,occurredAt,receivedAt:null,
      quote:{currency:'ARS',lines:[{itemId:item,itemName:'Original',sku:null,barcode:null,type:'PRODUCT',baseUnit:'UNIT',trackInventory:true,quantity:'2',unitPrice:'10.00',priceVersion:1,lineTotal:'20.00'}],subtotal:'20.00',discount:'0.00',total:'20.00',discountEvidence:null},
      payments:[{method:'CASH',appliedAmount:'20.00',receivedAmount:'25.00',changeAmount:'5.00'}],
      audit:{action:'sale.confirmed.offline',actorUserId:actor,grantId:JSON.parse(Buffer.from(String(operation.grant).split('.')[1] ?? '', 'base64url').toString()).grantId},
      receipt:{label:'Comprobante no fiscal',branchName:'Main'},result:{id,operationId:id,localReference:'LOCAL-2',total:'20.00',change:'5.00'}};
    const sale={...operation,id,kind:'sale-confirm',sequence:'2',sessionSequence:'2',previousHash,payload,occurredAt};
    await pool.query("UPDATE memberships SET status='ACTIVE',revoked_at=NULL WHERE organization_id=$1",[org]);
    await new CatalogPriceService(transactions).setPrice(context(),item,1,'99.00');
    await pool.query("UPDATE catalog_items SET status='INACTIVE' WHERE id=$1",[item]);
    await pool.query("UPDATE memberships SET status='REVOKED',revoked_at=now() WHERE organization_id=$1",[org]);
    const bytes=seal(sale);const first=await ingestion.ingest(claims,bytes);
    expect(first?.status).toBe('ACKED');expect(await ingestion.ingest(claims,bytes)).toEqual(first);
    expect((await pool.query('SELECT expected_cash FROM cash_sessions WHERE id=$1',[operation.sessionId])).rows[0]?.expected_cash).toBe('30.00');
    expect((await pool.query('SELECT quantity FROM branch_stocks WHERE item_id=$1',[item])).rows[0]?.quantity).toBe('-2.000');
    expect((await pool.query('SELECT status,max_shortfall FROM inventory_incidents')).rows[0]).toMatchObject({status:'OPEN',max_shortfall:'2.000'});
    expect((await pool.query('SELECT count(*)::integer AS n FROM sale_payments WHERE sale_id=$1',[id])).rows[0]?.n).toBe(1);
    const persisted=(await pool.query('SELECT receipt_snapshot,occurred_at,received_at FROM sales WHERE id=$1',[id])).rows[0];
    expect(persisted?.receipt_snapshot.items[0]).toMatchObject({name:'Original',unit:'UNIT',unitPrice:'10.00'});
    expect(persisted?.occurred_at.toISOString()).toBe(occurredAt);expect(persisted?.received_at).toBeInstanceOf(Date);
    operation=sale;exact=bytes;
  });

  it('T210 serializes competing deliveries and keeps one source per sale with maximum shortfall',async()=>{
    const make=(prior:Record<string,unknown>,sequence:string)=>{
      const id=randomUUID(),occurredAt=new Date().toISOString();
      const old=prior.payload as Record<string,unknown>;
      return {...prior,id,sequence,sessionSequence:sequence,previousHash:sha(canonicalEnvelopeJson(prior)),occurredAt,
        payload:{...old,id,occurredAt,localReference:`LOCAL-${sequence}`,result:{...(old.result as Record<string,unknown>),id,operationId:id,localReference:`LOCAL-${sequence}`}}};
    };
    const third=make(operation,'3'),fourth=make(third,'4'),thirdBytes=seal(third),fourthBytes=seal(fourth);
    await Promise.all([ingestion.ingest(claims,fourthBytes),ingestion.ingest(claims,thirdBytes),ingestion.ingest(claims,thirdBytes)]);
    expect((await ingestion.ingest(claims,fourthBytes))?.status).toBe('ACKED');
    expect((await pool.query('SELECT status,max_shortfall FROM inventory_incidents')).rows[0]).toMatchObject({status:'OPEN',max_shortfall:'6.000'});
    expect((await pool.query('SELECT count(*)::integer AS n FROM inventory_incident_sources')).rows[0]?.n).toBe(3);
    expect((await pool.query('SELECT quantity FROM branch_stocks WHERE item_id=$1',[item])).rows[0]?.quantity).toBe('-6.000');
    operation=fourth;exact=fourthBytes;
  });


  it('T210 reopens a corrected incident on a new legitimate offline sale and retains its maximum',async()=>{
    await pool.query("UPDATE memberships SET status='ACTIVE',revoked_at=NULL WHERE organization_id=$1",[org]);
    await pool.query("UPDATE catalog_items SET status='ACTIVE' WHERE id=$1",[item]);
    await new InventoryAdjustmentService(transactions).confirm(context(),{branchId:branch,itemId:item,direction:'INCREASE',quantity:'6',reason:'CORRECCION'},'intermediate-correction');
    expect((await pool.query('SELECT status FROM inventory_incidents')).rows[0]?.status).toBe('PENDING_REVIEW');
    await pool.query("UPDATE memberships SET status='REVOKED',revoked_at=now() WHERE organization_id=$1",[org]);
    const id=randomUUID(),occurredAt=new Date().toISOString(),prior=operation.payload as Record<string,unknown>;
    const sequence=(BigInt(String(operation.sequence))+1n).toString();
    const next={...operation,id,sequence,sessionSequence:sequence,previousHash:sha(canonicalEnvelopeJson(operation)),occurredAt,
      payload:{...prior,id,occurredAt,result:{...(prior.result as Record<string,unknown>),id,operationId:id}}};
    const bytes=seal(next);expect((await ingestion.ingest(claims,bytes))?.status).toBe('ACKED');
    expect((await pool.query('SELECT status,max_shortfall FROM inventory_incidents')).rows[0]).toMatchObject({status:'OPEN',max_shortfall:'6.000'});
    operation=next;exact=bytes;
  });
  it('T201/T209 rolls back every business effect if ACK signing fails',async()=>{
    const id=randomUUID(),occurredAt=new Date().toISOString(),previous=operation.payload as Record<string,unknown>;
    const sequence=(BigInt(String(operation.sequence))+1n).toString();
    const next={...operation,id,sequence,sessionSequence:sequence,previousHash:sha(canonicalEnvelopeJson(operation)),occurredAt,
      payload:{...previous,id,occurredAt,localReference:'LOCAL-5',result:{...(previous.result as Record<string,unknown>),id,operationId:id,localReference:'LOCAL-5'}}};
    const before=(await pool.query('SELECT quantity FROM branch_stocks WHERE item_id=$1',[item])).rows[0]?.quantity;
    const failing=new HistoricalDeliveryIngestion(transactions,new HistoricalEnvelopeValidator(certificates,custody),()=>{throw new Error('ACK custody unavailable');});
    await expect(failing.ingest(claims,seal(next))).rejects.toThrow('ACK custody unavailable');
    expect((await pool.query('SELECT quantity FROM branch_stocks WHERE item_id=$1',[item])).rows[0]?.quantity).toBe(before);
    expect((await pool.query('SELECT id FROM sales WHERE id=$1',[id])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM sync_operations WHERE id=$1',[id])).rowCount).toBe(0);
    expect((await pool.query('SELECT operation_id FROM offline_delivery_results WHERE operation_id=$1',[id])).rowCount).toBe(0);
  });
  it('T204 authenticates durable revocation knowledge, rejects rollback and reconstructs cutoffs under RLS',async()=>{
    const checkpoint={organizationId:org,deviceId:device,actorUserId:actor,sequence:String(operation.sequence),headHash:createHash('sha256').update(canonicalEnvelopeJson(operation)).digest('hex')};
    const signature=sign('sha256',Buffer.from(revocationCheckpointPayload(checkpoint)),{key:ec.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
    const apply=(value:typeof checkpoint,proof=signature)=>transactions.runWithOptionalAudit(context(),async client=>{
      await recordRevocationCheckpoint(client,claims,{...value,signature:proof});return {result:true};
    });
    await apply(checkpoint);await apply(checkpoint);
    await expect(apply({...checkpoint,sequence:'0'},'invalid')).rejects.toThrow();
    await expect(apply({...checkpoint,organizationId:foreign})).rejects.toThrow();
    expect(await transactions.read(context(),client=>readRevocationKnowledge(client,org,device,actor))).toMatchObject({actorSequence:String(operation.sequence),deviceSequence:null});
    expect((await pool.query("SELECT count(*)::integer AS n FROM audit_events WHERE action='offline.revocation_known'")).rows[0]?.n).toBe(1);
  });


  it('T204 returns a stable SECURITY_REJECTED ACK for post-knowledge creation without business effects',async()=>{
    const id=randomUUID(),occurredAt=new Date().toISOString(),prior=operation.payload as Record<string,unknown>;
    const sequence=(BigInt(String(operation.sequence))+1n).toString();
    const next={...operation,id,sequence,sessionSequence:sequence,previousHash:sha(canonicalEnvelopeJson(operation)),occurredAt,
      payload:{...prior,id,occurredAt,result:{...(prior.result as Record<string,unknown>),id,operationId:id}}};
    const bytes=seal(next);const first=await ingestion.ingest(claims,bytes);
    expect(first?.status).toBe('SECURITY_REJECTED');expect(await ingestion.ingest(claims,bytes)).toEqual(first);
    expect((await pool.query('SELECT id FROM sales WHERE id=$1',[id])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM sync_operations WHERE id=$1',[id])).rowCount).toBe(0);
  });
  it('T211 links positive corrections and moves a non-negative incident to pending review',async()=>{
    await pool.query("UPDATE memberships SET status='ACTIVE',revoked_at=NULL WHERE organization_id=$1",[org]);
    await pool.query("UPDATE catalog_items SET status='ACTIVE' WHERE id=$1",[item]);
    const input={branchId:branch,itemId:item,direction:'INCREASE' as const,quantity:'2',reason:'CORRECCION'};
    const negativeIncident=(await pool.query('SELECT id FROM inventory_incidents')).rows[0]?.id as string;
    await expect(new InventoryIncidentService(transactions).resolve(context(),negativeIncident,'Todavía negativo','negative')).rejects.toThrow('INCIDENT_NOT_REVIEWABLE');
    const adjustment=new InventoryAdjustmentService(transactions);
    await adjustment.confirm(context(),input,'correct-negative');await adjustment.confirm(context(),input,'correct-negative');
    expect((await pool.query('SELECT quantity FROM branch_stocks WHERE item_id=$1',[item])).rows[0]?.quantity).toBe('0.000');
    expect((await pool.query('SELECT status,max_shortfall FROM inventory_incidents')).rows[0]).toMatchObject({status:'PENDING_REVIEW',max_shortfall:'6.000'});
    expect((await pool.query('SELECT count(*)::integer AS n FROM inventory_incident_corrections')).rows[0]?.n).toBe(2);
  });

  it('T212 resolves once with required note and denies unauthorized/cross-tenant access',async()=>{
    const incident=(await pool.query('SELECT id FROM inventory_incidents')).rows[0]?.id as string;
    const service=new InventoryIncidentService(transactions);
    await expect(service.resolve(context(),incident,'','empty')).rejects.toThrow();
    await expect(service.resolve({...context(),organizationId:foreign},incident,'Reviewed','foreign')).rejects.toThrow();
    const first=await service.resolve(context(),incident,'Saldo corregido y verificado','resolve');
    expect(first).toMatchObject({id:incident,status:'RESOLVED'});
    expect(await service.resolve(context(),incident,'Saldo corregido y verificado','resolve')).toEqual(first);
    expect((await pool.query("SELECT count(*)::integer AS n FROM audit_events WHERE action='inventory.incident.resolved'")).rows[0]?.n).toBe(1);
  });

  it('T212 permits scoped ADMIN and rejects EMPLOYEE and other branches',async()=>{
    const admin=randomUUID(),employee=randomUUID(),membership=randomUUID(),otherBranch=randomUUID();
    await pool.query("INSERT INTO users (id,email_normalized,password_hash,password_hash_version) VALUES ($1,'incident-admin@example.com','$argon2id$v=19$test',1),($2,'incident-employee@example.com','$argon2id$v=19$test',1)",[admin,employee]);
    await pool.query("INSERT INTO memberships (id,organization_id,user_id,role) VALUES ($1,$2,$3,'ADMIN'),($4,$2,$5,'EMPLOYEE')",[membership,org,admin,randomUUID(),employee]);
    await pool.query('INSERT INTO membership_branches (organization_id,membership_id,branch_id) VALUES ($1,$2,$3)',[org,membership,branch]);
    await pool.query("INSERT INTO branches (id,organization_id,name) VALUES ($1,$2,'Other')",[otherBranch,org]);
    const own=randomUUID(),outside=randomUUID();
    await pool.query("INSERT INTO inventory_incidents (id,organization_id,branch_id,item_id,status,max_shortfall) VALUES ($1,$2,$3,$4,'PENDING_REVIEW',1),($5,$2,$6,$4,'PENDING_REVIEW',1)",[own,org,branch,item,outside,otherBranch]);
    const service=new InventoryIncidentService(transactions);
    await expect(service.resolve({...context(),userId:employee},own,'Reviewed','employee')).rejects.toThrow('forbidden');
    await expect(service.resolve({...context(),userId:admin},outside,'Reviewed','admin-outside')).rejects.toThrow('forbidden');
    expect(await service.resolve({...context(),userId:admin},own,'Corregido y revisado','admin-own')).toMatchObject({status:'RESOLVED'});
  });

});
