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
import { CashCloseService } from '../src/modules/cash/cash-close.service.js';
import { OfflineSaleImporter } from '../src/modules/sales/index.js';
import { ExceptionalClosePreparation } from '../src/modules/cash/exceptional-close-preparation.js';
import { UnrecoverableDeviceService } from '../src/modules/offline-sync/unrecoverable-device.service.js';
import { ExceptionalCashCloseService } from '../src/modules/cash/exceptional-cash-close.service.js';
import { LateCashReviewService } from '../src/modules/cash/late-cash-review.service.js';
import { CashWorkspaceService } from '../src/modules/cash/cash-workspace.service.js';

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
function seal(operation: Record<string,unknown>,transportCertificate=certificate) {
  const routing={version:1,keyId:'rsa',operationId:operation.id,certificate:transportCertificate};
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
  it('T215 serializes a legitimate new envelope against begin-close without partial effects',async()=>{
    await pool.query("UPDATE memberships SET status='ACTIVE',revoked_at=NULL WHERE organization_id=$1",[org]);
    const checkpoint={version:1 as const,organizationId:org,deviceId:device,actorUserId:actor,sessionId:String(operation.sessionId),
      sequence:String(operation.sequence),headHash:createHash('sha256').update(canonicalEnvelopeJson(operation)).digest('hex'),
      sessionSequence:String(operation.sessionSequence),creationFrozen:true as const,pending:0 as const};
    const proof=sign('sha256',Buffer.from(JSON.stringify(checkpoint)),{key:ec.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
    const id=randomUUID(),occurredAt=new Date().toISOString(),prior=operation.payload as Record<string,unknown>;
    const sequence=(BigInt(String(operation.sequence))+1n).toString();
    const next={...operation,id,sequence,sessionSequence:sequence,previousHash:sha(canonicalEnvelopeJson(operation)),occurredAt,
      payload:{...prior,id,occurredAt,result:{...(prior.result as Record<string,unknown>),id,operationId:id}}};
    const bytes=seal(next),service=new CashCloseService(transactions);
    const race=await Promise.allSettled([service.begin(context(),{checkpoint,signature:proof},randomUUID()),ingestion.ingest(claims,bytes)]);
    const close=race[0];
    if (close?.status==='fulfilled') {
      expect(race[1]?.status).toBe('rejected');
      expect((await pool.query('SELECT id FROM sync_operations WHERE id=$1',[id])).rowCount).toBe(0);
      await service.abort(context(),{cashSessionId:checkpoint.sessionId,deviceId:device,closeAttemptId:close.value.closeAttemptId},randomUUID());
    } else {
      expect(close?.status).toBe('rejected');
      if (close?.status==='rejected') expect(close.reason).toMatchObject({code:'CASH_CHECKPOINT_INVALID'});
      expect(race[1]?.status).toBe('fulfilled');
    }
    expect((await ingestion.ingest(claims,bytes))?.status).toBe('ACKED');
    expect((await pool.query('SELECT count(*)::integer AS n FROM sales WHERE id=$1',[id])).rows[0]?.n).toBe(1);
    operation=next;exact=bytes;
    await pool.query("UPDATE memberships SET status='REVOKED',revoked_at=now() WHERE organization_id=$1",[org]);
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
    const negative=(await pool.query<{quantity:string}>('SELECT quantity::text FROM branch_stocks WHERE item_id=$1',[item])).rows[0]?.quantity;
    if (!negative?.startsWith('-')) throw new Error('Expected negative stock before correction');
    const input={branchId:branch,itemId:item,direction:'INCREASE' as const,quantity:negative.slice(1),reason:'CORRECCION'};
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

  it('T214B-C verifies applied device and session chains before closing an imported session', async () => {
    const checkpoint = { version: 1 as const, organizationId: org, deviceId: device, actorUserId: actor,
      sessionId: String(operation.sessionId), sequence: String(operation.sequence),
      headHash: createHash('sha256').update(canonicalEnvelopeJson(operation)).digest('hex'),
      sessionSequence: String(operation.sessionSequence), creationFrozen: true as const, pending: 0 as const };
    const signed = (value: typeof checkpoint) => ({ checkpoint: value,
      signature: sign('sha256', Buffer.from(JSON.stringify(value)), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') });
    const service = new CashCloseService(transactions);
    await expect(service.begin(context(), signed({ ...checkpoint, headHash: '0'.repeat(64) }), randomUUID())).rejects.toThrow('CASH_CHECKPOINT_INVALID');
    await expect(service.begin(context(), signed({ ...checkpoint, sequence: (BigInt(checkpoint.sequence)+1n).toString() }), randomUUID())).rejects.toThrow('CASH_CHECKPOINT_INVALID');
    await expect(service.begin(context(), signed({ ...checkpoint, sessionSequence: '0' }), randomUUID())).rejects.toThrow('CASH_CHECKPOINT_INVALID');
    const result = await service.begin(context(), signed(checkpoint), randomUUID());
    const final = await service.finalSync(context(), { cashSessionId: checkpoint.sessionId, deviceId: device, closeAttemptId: result.closeAttemptId }, randomUUID());
    expect(final.expectedCash).toBe((await pool.query('SELECT expected_cash FROM cash_sessions WHERE id=$1', [checkpoint.sessionId])).rows[0]?.expected_cash);
    expect((await ingestion.ingest(claims, exact))?.status).toBe('ACKED');
    const newId=randomUUID();
    await expect(transactions.runWithOptionalAudit(context(),async client=>({result:await new OfflineSaleImporter().apply(client,context(),
      {...operation.payload as Record<string,unknown>,id:newId},newId)}))).rejects.toThrow('OFFLINE_SALE_SESSION_INVALID');
    expect((await pool.query('SELECT id FROM sales WHERE id=$1',[newId])).rowCount).toBe(0);
    const exposures=(await pool.query('SELECT count(*)::integer AS n FROM offline_configuration_exposures WHERE organization_id=$1 AND cleared_at IS NULL',[org])).rows[0]?.n;
    expect((await new UnrecoverableDeviceService(transactions).declare(context(),device)).permanentlyLocked).toBe(true);
    const preparation=new ExceptionalClosePreparation();
    const snapshot=await transactions.runWithOptionalAudit(context(),async client=>{
      const prepared=await preparation.prepare(client,context(),{cashSessionId:checkpoint.sessionId,confirm:true,reason:'Dispositivo irrecuperable',countedCash:'90.00'});
      return {result:await preparation.snapshot(client,context(),prepared)};
    });
    expect(snapshot).toMatchObject({operationalDataCompleteness:'UNKNOWN',currencyPermanentlyLocked:true,countedCash:'90.00'});
    expect(snapshot.operationsReceived).toHaveLength(Number(operation.sequence));
    expect((await pool.query('SELECT count(*)::integer AS n FROM offline_configuration_exposures WHERE organization_id=$1 AND cleared_at IS NULL',[org])).rows[0]?.n).toBe(exposures);
  });
  it('T218 imports presealed late sales atomically without rewriting exceptional closure or releasing D01',async()=>{
    const lateOrg=randomUUID(),lateActor=randomUUID(),lateBranch=randomUUID(),lateDevice=randomUUID(),lateRegister=randomUUID(),lateItem=randomUUID(),sessionId=randomUUID();
    const lateContext=()=>({organizationId:lateOrg,userId:lateActor,requestId:randomUUID()});
    await pool.query("INSERT INTO users (id,email_normalized,password_hash,password_hash_version) VALUES ($1,'late@example.com','$argon2id$v=19$test',1)",[lateActor]);
    await pool.query("INSERT INTO organizations (id,base_currency,timezone) VALUES ($1,'ARS','UTC')",[lateOrg]);
    await pool.query("INSERT INTO memberships (id,organization_id,user_id,role) VALUES ($1,$2,$3,'OWNER')",[randomUUID(),lateOrg,lateActor]);
    await pool.query("INSERT INTO branches (id,organization_id,name) VALUES ($1,$2,'Late')",[lateBranch,lateOrg]);
    await pool.query("INSERT INTO cash_registers (id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Late')",[lateRegister,lateOrg,lateBranch]);
    await pool.query("INSERT INTO devices (id,organization_id,branch_id,authorized_by_user_id,authorized_at,status,public_key,public_key_thumbprint) VALUES ($1,$2,$3,$4,now(),'ACTIVE',$5,$6)",
      [lateDevice,lateOrg,lateBranch,lateActor,publicKey,certificates.thumbprint(publicKey)]);
    await pool.query("INSERT INTO catalog_items (id,organization_id,name,type,base_unit,track_inventory,price,price_version) VALUES ($1,$2,'Late product','PRODUCT','UNIT',true,10,1)",[lateItem,lateOrg]);
    const bootstrap=await new OfflineBootstrapService(transactions,signer,custody).issue(lateContext(),{deviceId:lateDevice,branchId:lateBranch},'late-bootstrap');
    const config=JSON.parse(bootstrap.payload);
    const grantProof={grantId:config.grantId as string,bootstrapHash:createHash('sha256').update(bootstrap.payload).digest('hex'),deviceSequence:'0',headHash:null};
    const grant=(await new OfflineGrantService(transactions,ec.privateKey,'trusted').issue(lateContext(),{...grantProof,
      proof:sign('sha256',Buffer.from(offlineGrantProofPayload(grantProof)),{key:ec.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')},'late-grant')).grant;
    const lateCertificate=certificates.issue({organizationId:lateOrg,deviceId:lateDevice,thumbprint:certificates.thumbprint(publicKey)}),lateClaims=certificates.open(lateCertificate);
    const occurredAt=new Date().toISOString();
    const opening={id:randomUUID(),actorId:lateActor,organizationId:lateOrg,deviceId:lateDevice,sessionId,sequence:'1',sessionSequence:'1',previousHash:null,
      kind:'cash-session-open',grant,configVersion:config.configurationVersion,occurredAt,receivedAt:null,
      payload:{id:sessionId,actorUserId:lateActor,branchId:lateBranch,cashRegisterId:lateRegister,openingCash:'10.00',currency:'ARS',openedAt:occurredAt,status:'OPEN'}};
    expect((await ingestion.ingest(lateClaims,seal(opening,lateCertificate)))?.status).toBe('ACKED');
    const id=randomUUID(),sale={...opening,id,kind:'sale-confirm',sequence:'2',sessionSequence:'2',previousHash:sha(canonicalEnvelopeJson(opening)),
      payload:{id,localReference:'LATE-2',reference:null,status:'CONFIRMED',requestHash:sha('late-request'),actorUserId:lateActor,deviceId:lateDevice,
        organizationId:lateOrg,branchId:lateBranch,cashSessionId:sessionId,customerId:null,customerKind:'CONSUMER_FINAL',configurationVersion:config.configurationVersion,
        occurredAt,receivedAt:null,quote:{currency:'ARS',lines:[{itemId:lateItem,itemName:'Late product',sku:null,barcode:null,type:'PRODUCT',baseUnit:'UNIT',
          trackInventory:true,quantity:'2',unitPrice:'10.00',priceVersion:1,lineTotal:'20.00'}],subtotal:'20.00',discount:'0.00',total:'20.00',discountEvidence:null},
        payments:[{method:'CASH',appliedAmount:'20.00',receivedAmount:'20.00',changeAmount:'0.00'}],audit:{action:'sale.confirmed.offline',actorUserId:lateActor,grantId:config.grantId},
        receipt:{label:'Comprobante no fiscal',branchName:'Late'},result:{id,operationId:id,localReference:'LATE-2',total:'20.00',change:'0.00'}}};
    const pending=seal(sale,lateCertificate);
    const nextId=randomUUID(),nextSale={...sale,id:nextId,sequence:'3',sessionSequence:'3',previousHash:sha(canonicalEnvelopeJson(sale)),
      payload:{...sale.payload,id:nextId,localReference:'LATE-3',result:{...sale.payload.result,id:nextId,operationId:nextId,localReference:'LATE-3'}}};
    const nextPending=seal(nextSale,lateCertificate);
    expect((await new UnrecoverableDeviceService(transactions).declare(lateContext(),lateDevice)).permanentlyLocked).toBe(true);
    await new ExceptionalCashCloseService(transactions).close(lateContext(),{cashSessionId:sessionId,confirm:true,reason:'Dispositivo perdido'},'late-exception');
    const original=(await pool.query('SELECT snapshot FROM cash_exceptional_closures WHERE cash_session_id=$1',[sessionId])).rows[0]?.snapshot;
    const failing=new HistoricalDeliveryIngestion(transactions,new HistoricalEnvelopeValidator(certificates,custody),()=>{throw new Error('ACK unavailable');});
    await expect(failing.ingest(lateClaims,pending)).rejects.toThrow('ACK unavailable');
    expect((await pool.query('SELECT id FROM sales WHERE id=$1',[id])).rowCount).toBe(0);
    const results=await Promise.all([ingestion.ingest(lateClaims,pending),ingestion.ingest(lateClaims,pending)]);
    expect(results[0]?.status).toBe('ACKED');expect(results[1]).toEqual(results[0]);
    expect((await pool.query('SELECT snapshot FROM cash_exceptional_closures WHERE cash_session_id=$1',[sessionId])).rows[0]?.snapshot).toEqual(original);
    expect((await pool.query('SELECT status,completeness,expected_cash FROM cash_sessions WHERE id=$1',[sessionId])).rows[0])
      .toMatchObject({status:'CLOSED_WITH_UNRECOVERED_DEVICE',completeness:'UNKNOWN',expected_cash:'30.00'});
    expect((await pool.query('SELECT marker FROM cash_late_recoveries WHERE organization_id=$1 AND operation_id=$2',[lateOrg,id])).rows)
      .toEqual([{marker:'LATE_RECOVERED_OPERATIONS'}]);
    expect((await pool.query('SELECT currency_permanently_locked_at FROM organizations WHERE id=$1',[lateOrg])).rows[0]?.currency_permanently_locked_at).toBeInstanceOf(Date);
    expect((await pool.query('SELECT 1 FROM offline_configuration_exposures WHERE organization_id=$1 AND cleared_at IS NULL',[lateOrg])).rowCount).toBeGreaterThan(0);
    expect((await pool.query('SELECT 1 FROM configuration_versions WHERE organization_id=$1 AND version=$2',[lateOrg,config.configurationVersion])).rowCount).toBe(1);
    const review=new LateCashReviewService(transactions);
    const workspace=new CashWorkspaceService(transactions);
    await expect(workspace.read(context(),lateBranch,{view:'FINAL',sessionId})).rejects.toThrow();
    expect((await workspace.read(lateContext(),lateBranch,{view:'FINAL'})).sessions.find(row=>row.id===sessionId))
      .toMatchObject({deviceStatus:'UNRECOVERABLE',completeness:'UNKNOWN',exceptionalClosure:{expectedCashKnown:'10.00',countedCash:null,
        differenceObserved:null,lastContactAt:null,reason:'Dispositivo perdido'},
        lateData:{marker:'LATE_RECOVERED_OPERATIONS',throughOperationId:id,status:'PENDING_REVIEW',count:'1'}});
    await pool.query("INSERT INTO memberships (id,organization_id,user_id,role) VALUES ($1,$2,$3,'CASHIER')",[randomUUID(),lateOrg,actor]);
    await expect(review.review({...lateContext(),userId:actor},sessionId,id,'Revisado',randomUUID())).rejects.toThrow();
    await expect(review.review(context(),sessionId,id,'Revisado',randomUUID())).rejects.toThrow();
    const reviewKey=randomUUID();
    const reviewed=await review.review(lateContext(),sessionId,id,'Operaciones recuperadas verificadas',reviewKey);
    expect(reviewed).toMatchObject({cashSessionId:sessionId,status:'REVIEWED',throughOperationId:id});
    expect(await review.review(lateContext(),sessionId,id,'Operaciones recuperadas verificadas',reviewKey)).toEqual(reviewed);
    expect((await workspace.read(lateContext(),lateBranch,{view:'FINAL'})).sessions.find(row=>row.id===sessionId))
      .toMatchObject({lateData:{throughOperationId:id,status:'REVIEWED'},exceptionalClosure:{expectedCashKnown:'10.00'}});
    expect((await pool.query('SELECT snapshot FROM cash_exceptional_closures WHERE cash_session_id=$1',[sessionId])).rows[0]?.snapshot).toEqual(original);
    expect((await pool.query('SELECT completeness,status FROM cash_sessions WHERE id=$1',[sessionId])).rows[0])
      .toMatchObject({status:'CLOSED_WITH_UNRECOVERED_DEVICE',completeness:'UNKNOWN'});
    expect((await ingestion.ingest(lateClaims,nextPending))?.status).toBe('ACKED');
    expect((await workspace.read(lateContext(),lateBranch,{view:'FINAL'})).sessions.find(row=>row.id===sessionId))
      .toMatchObject({expectedCash:'50.00',completeness:'UNKNOWN',lateData:{throughOperationId:nextId,status:'PENDING_REVIEW',count:'2'}});
    await expect(review.review(lateContext(),sessionId,id,'Formulario antiguo',randomUUID())).rejects.toThrow('CASH_CLOSE_STATE_INVALID');
    expect(await review.review(lateContext(),sessionId,nextId,'Segunda recuperación revisada',randomUUID())).toMatchObject({throughOperationId:nextId,status:'REVIEWED'});
    expect((await pool.query('SELECT snapshot FROM cash_exceptional_closures WHERE cash_session_id=$1',[sessionId])).rows[0]?.snapshot).toEqual(original);
    expect((await pool.query('SELECT count(*)::integer AS n FROM cash_late_recoveries WHERE cash_session_id=$1',[sessionId])).rows[0]?.n).toBe(2);
    expect((await pool.query('SELECT status,completeness,expected_cash FROM cash_sessions WHERE id=$1',[sessionId])).rows[0])
      .toMatchObject({status:'CLOSED_WITH_UNRECOVERED_DEVICE',completeness:'UNKNOWN',expected_cash:'50.00'});
    await expect(pool.query(`INSERT INTO cash_movements (id,organization_id,branch_id,cash_session_id,actor_user_id,device_id,delta,currency_code,source_type,source_id,effect_kind)
      VALUES ($1,$2,$3,$4,$5,$6,'1.00','ARS','MANUAL',$1,'IN')`,[randomUUID(),lateOrg,lateBranch,sessionId,lateActor,lateDevice]))
      .rejects.toThrow('does not accept movements');
  });
});
