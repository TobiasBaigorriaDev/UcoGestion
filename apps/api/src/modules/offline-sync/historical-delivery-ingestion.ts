import { createPublicKey, randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { signOfflineAck,verifyOfflineAck } from './offline-ack.js';
import { readRevocationKnowledge } from './revocation-checkpoint.js';
import { z } from 'zod';
import { AuditEventWriter } from '../../core/audit/audit-event-writer.js';
import { TenantTransaction } from '../../database/tenant-transaction.js';
import { OfflineSaleImporter } from '../sales/index.js';
import { OfflineCashOpeningImporter } from '../cash/index.js';
import type { DeviceCertificateClaims } from './device-certificate.js';
import { HistoricalEnvelopeValidator } from './historical-envelope-validator.js';
import { readHistoricalEnvelopeContext } from './historical-envelope-context.js';
import { readEnvelopeOrder } from './offline-envelope-order.js';
import { recordOfflineReceipt } from './sync-operation-receipt.js';
import type { HistoricalDeliveryIngestionPort } from './offline-delivery.service.js';
import { recordConfigurationDiscrepancy } from './configuration-discrepancy.js';

export interface DeliveryResult {
  readonly operationId: string; readonly ack:string; readonly envelopeHash: string; readonly status:'ACKED'|'SECURITY_REJECTED';
}
export class HistoricalDeliveryIngestion implements HistoricalDeliveryIngestionPort {
  constructor(private readonly transactions:TenantTransaction, private readonly validator:HistoricalEnvelopeValidator, private readonly ackKey:(keyId:string)=>KeyObject,
    private readonly recordResult?: (result:'ACKED'|'SECURITY_REJECTED'|'RETRY')=>void) {}
  private signAck(result:Omit<DeliveryResult,'ack'>,history:{signingKeyId:string;signingPublicKey:string}):string {
    const ack=signOfflineAck(result,this.ackKey(history.signingKeyId),history.signingKeyId);
    verifyOfflineAck(ack,createPublicKey(history.signingPublicKey),history.signingKeyId,result);
    return ack;
  }
  async deliver(certificate:DeviceCertificateClaims,envelopes:readonly string[]) {
    const acks:string[]=[];
    for (const envelope of envelopes) {
      try {
        const result=await this.ingest(certificate,envelope);
        this.recordResult?.(result?.status ?? 'RETRY');
        if (result) acks.push(result.ack);
      } catch (error) { this.recordResult?.('RETRY'); throw error; }
    }
    return {acks};
  }
  async ingest(certificate:DeviceCertificateClaims,exactEnvelope:string):Promise<DeliveryResult|undefined> {
    return this.transactions.runWithOptionalAudit({organizationId:certificate.organizationId,userId:'',requestId:randomUUID()},async client=>{
      // Same order as bootstrap/configuration barriers, before the device lock.
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[certificate.organizationId]);
      const device=(await client.query<{public_key:string;public_key_thumbprint:string}>(
        'SELECT public_key,public_key_thumbprint FROM devices WHERE organization_id=$1 AND id=$2 FOR UPDATE',
        [certificate.organizationId,certificate.deviceId])).rows[0];
      if (!device || device.public_key_thumbprint!==certificate.thumbprint) throw new Error('OFFLINE_DELIVERY_REJECTED');
      const opened=await this.validator.open(exactEnvelope,device.public_key);
      if (opened.certificate.organizationId!==certificate.organizationId || opened.certificate.deviceId!==certificate.deviceId) throw new Error('OFFLINE_DELIVERY_REJECTED');
      const operation=opened.operation;
      const existing=(await client.query<{envelope_hash:string;ack_jws:string;status:DeliveryResult['status']}>(
        'SELECT envelope_hash,status,ack_jws FROM offline_delivery_results WHERE organization_id=$1 AND device_id=$2 AND operation_id=$3',
        [certificate.organizationId,certificate.deviceId,operation.id])).rows[0];
      if (existing) {
        if (existing.envelope_hash!==opened.envelopeHash) throw new Error('SYNC_RECEIPT_CONFLICT');
        return {result:{operationId:operation.id,envelopeHash:opened.envelopeHash,status:existing.status,ack:existing.ack_jws}};
      }
      await client.query("SELECT set_config('app.user_id',$1,true)",[operation.actorId]);
      const knowledge=await readRevocationKnowledge(client,operation.organizationId,operation.deviceId,operation.actorId);
      const history=await readHistoricalEnvelopeContext(client,{organizationId:certificate.organizationId,
        deviceId:certificate.deviceId,actorUserId:operation.actorId,grantJws:operation.grant},
      knowledge);
      let validated:ReturnType<HistoricalEnvelopeValidator['validate']>;
      try { validated=this.validator.validate(opened,history); }
      catch {
        const ack=this.signAck({operationId:operation.id,envelopeHash:opened.envelopeHash,status:'SECURITY_REJECTED'},history);
        await client.query("INSERT INTO offline_delivery_results (organization_id,device_id,operation_id,envelope_hash,status,ack_jws) VALUES ($1,$2,$3,$4,'SECURITY_REJECTED',$5)",
          [operation.organizationId,operation.deviceId,operation.id,opened.envelopeHash,ack]);
        await new AuditEventWriter(client).append({organizationId:operation.organizationId,actorUserId:operation.actorId,requestId:randomUUID(),
          action:'offline.security_rejected',entityType:'sync_operation',entityId:operation.id,operationId:operation.id,branchId:history.branchId,
          deviceId:operation.deviceId,before:{},after:{},context:{envelopeHash:opened.envelopeHash},beforeAllowlist:[],afterAllowlist:[],contextAllowlist:['envelopeHash']});
        return {result:{operationId:operation.id,envelopeHash:opened.envelopeHash,status:'SECURITY_REJECTED' as const,ack}};
      }
      for (const [sequence,head] of [[knowledge.deviceSequence,knowledge.deviceHeadHash],[knowledge.actorSequence,knowledge.actorHeadHash]]) {
        if (sequence===operation.sequence && head!==Buffer.from(opened.operationHash,'base64').toString('hex')) throw new Error('OFFLINE_HISTORY_INVALID');
      }
      const order=await readEnvelopeOrder(client,{id:operation.id,organizationId:operation.organizationId,deviceId:operation.deviceId,
        sessionId:operation.sessionId,sequence:operation.sequence,sessionSequence:operation.sessionSequence,previousHash:operation.previousHash,
        kind:operation.kind,operationHash:opened.operationHash,envelopeHash:opened.envelopeHash});
      if (order==='WAITING_DEPENDENCY') return {result:undefined};
      if (order!=='READY') throw new Error('SYNC_RECEIPT_CONFLICT');
      await recordOfflineReceipt(client,{id:operation.id,organizationId:operation.organizationId,deviceId:operation.deviceId,
        grantId:validated.claims.grantId,epoch:validated.claims.epoch,sequence:operation.sequence,
        previousHash:operation.previousHash===null ? '0'.repeat(64):Buffer.from(operation.previousHash,'base64').toString('hex'),
        operationHash:Buffer.from(opened.operationHash,'base64').toString('hex'),occurredAt:operation.occurredAt,
        envelope:{sessionId:operation.sessionId,sessionSequence:operation.sessionSequence,kind:operation.kind,hash:opened.envelopeHash}});
      if (operation.kind==='cash-session-open') {
      const payload=z.object({id:z.uuid(),branchId:z.uuid(),cashRegisterId:z.uuid(),openingCash:z.string(),currency:z.string(),openedAt:z.string()}).parse(operation.payload);
      await new OfflineCashOpeningImporter().apply(client,{organizationId:operation.organizationId,userId:operation.actorId,requestId:randomUUID()},
        {...payload,operationId:operation.id,organizationId:operation.organizationId,actorUserId:operation.actorId,
          deviceId:operation.deviceId,grantId:validated.claims.grantId});
      } else await new OfflineSaleImporter().apply(client,{organizationId:operation.organizationId,userId:operation.actorId,requestId:randomUUID()},operation.payload,operation.id);
      await recordConfigurationDiscrepancy(client,operation,history.configuration);
      await client.query("UPDATE sync_operations SET status='ACKED' WHERE organization_id=$1 AND id=$2",[operation.organizationId,operation.id]);
      const ack=this.signAck({operationId:operation.id,envelopeHash:opened.envelopeHash,status:'ACKED'},history);
      await client.query("INSERT INTO offline_delivery_results (organization_id,device_id,operation_id,envelope_hash,status,ack_jws) VALUES ($1,$2,$3,$4,'ACKED',$5)",
        [operation.organizationId,operation.deviceId,operation.id,opened.envelopeHash,ack]);
      return {result:{operationId:operation.id,envelopeHash:opened.envelopeHash,status:'ACKED' as const,ack}};
    });
  }
}
