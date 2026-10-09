import { OfflineDatabase } from './offline-database';
import { OfflineLease } from './offline-lease';
import { z } from 'zod';
import { assertOfflineIdentity } from './offline-revocation';
import { base64,bytes,unbase64 } from './offline-crypto';

const sequence=z.string().regex(/^(0|[1-9]\d{0,18})$/);
export const closeChainSchema=z.strictObject({sequence,headHash:z.string().regex(/^[0-9a-f]{64}$/),sessionSequence:sequence});
const checkpointSchema=z.strictObject({version:z.literal(1),organizationId:z.uuid(),deviceId:z.uuid(),actorUserId:z.uuid(),
  sessionId:z.uuid(),sequence,headHash:z.string().regex(/^[0-9a-f]{64}$/),sessionSequence:sequence,
  creationFrozen:z.literal(true),pending:z.literal(0)});
const signedSchema=z.strictObject({checkpoint:checkpointSchema,signature:z.string().max(128),key:z.uuid()});

/** Session freeze survives reload and is shared by all identities and tabs. */
export class OfflineCloseBarrier {
  constructor(private readonly db: OfflineDatabase) {}

  /** Freeze/drain first, then compare the applied server chain with our durable local head.
   * The signed request is kept unchanged across response loss and reload. It contains no money or motives. */
  async checkpoint(actorUserId:string,sessionId:string,readChain:()=>Promise<z.infer<typeof closeChainSchema>>,
    drain:()=>Promise<void>=async()=>{}) {
    z.uuid().parse(actorUserId);z.uuid().parse(sessionId);
    await this.prepare(sessionId,drain);
    const chain=closeChainSchema.parse(await readChain());
    const leases=new OfflineLease(this.db),lease=await leases.acquire(crypto.randomUUID());
    try {
      await assertOfflineIdentity(this.db,actorUserId);
      const device=await this.db.device_keys.get('device');
      if(!device || device.revoked)throw new Error('OFFLINE_CHECKPOINT_INVALID');
      const existing=device.closeCheckpoints?.find(row=>row.checkpoint.sessionId===sessionId && row.checkpoint.actorUserId===actorUserId);
      if(existing) return signedSchema.parse(existing);
      const head=lease.headHash===null ? '0'.repeat(64) : Array.from(unbase64(lease.headHash),v=>v.toString(16).padStart(2,'0')).join('');
      if(chain.sequence!==lease.sequence || chain.headHash!==head)throw new Error('OFFLINE_CHECKPOINT_INVALID');
      // Field order is the versioned HTTP signature domain; canonical sorted JSON is a different domain.
      const checkpoint=checkpointSchema.parse({version:1,organizationId:this.db.organizationId,deviceId:this.db.deviceId,
        actorUserId,sessionId,sequence:lease.sequence,headHash:head,sessionSequence:chain.sessionSequence,creationFrozen:true,pending:0});
      const signature=base64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},device.signingKey,
        bytes(new TextEncoder().encode(JSON.stringify(checkpoint))))));
      const signed={checkpoint,signature,key:crypto.randomUUID()};
      await this.db.transaction('rw',[this.db.meta,this.db.device_keys,this.db.delivery_queue],async()=>{
        await leases.assert(lease);await assertOfflineIdentity(this.db,actorUserId);
        const current=await this.db.device_keys.get('device');
        if(!current?.closingSessions?.includes(sessionId) || await this.db.delivery_queue.count())throw new Error('OFFLINE_PENDING');
        await this.db.device_keys.put({...current,closeCheckpoints:[...(current.closeCheckpoints ?? []),signed]});
      });
      return signed;
    }finally{await leases.release(lease);}
  }

  async releaseAfterAbort(sessionId:string,attemptId:string,response:unknown):Promise<void> {
    const parsed=z.strictObject({cashSessionId:z.uuid(),closeAttemptId:z.uuid(),status:z.literal('OPEN')}).safeParse(response);
    if(!parsed.success || parsed.data.cashSessionId!==sessionId || parsed.data.closeAttemptId!==attemptId)throw new Error('OFFLINE_CHECKPOINT_INVALID');
    const leases=new OfflineLease(this.db),lease=await leases.acquire(crypto.randomUUID());
    try {
      await this.db.transaction('rw',[this.db.meta,this.db.device_keys],async()=>{
        await leases.assert(lease);
        const current=await this.db.device_keys.get('device');
        if(!current || current.revoked)throw new Error('OFFLINE_CHECKPOINT_INVALID');
        await this.db.device_keys.put({...current,closingSessions:(current.closingSessions ?? []).filter(id=>id!==sessionId),
          closeCheckpoints:(current.closeCheckpoints ?? []).filter(row=>row.checkpoint.sessionId!==sessionId)});
      });
    }finally{await leases.release(lease);}
  }

  async completeAfterClose(sessionId:string,response:unknown,attemptId?:string):Promise<void> {
    const parsed=z.object({cashSessionId:z.uuid(),status:z.enum(['CLOSED','CLOSED_CONFLICT_RESOLVED']),closeAttemptId:z.uuid().optional()}).safeParse(response);
    if(!parsed.success || parsed.data.cashSessionId!==sessionId || (attemptId && parsed.data.closeAttemptId!==attemptId))throw new Error('OFFLINE_CHECKPOINT_INVALID');
    const leases=new OfflineLease(this.db),lease=await leases.acquire(crypto.randomUUID());
    try {
      await this.db.transaction('rw',[this.db.meta,this.db.device_keys,this.db.delivery_queue,this.db.records],async()=>{
        await leases.assert(lease);
        if(await this.db.delivery_queue.count())throw new Error('OFFLINE_PENDING');
        if(lease.cashSessionOpen) {
          if(lease.cashSessionId && lease.cashSessionId!==sessionId)throw new Error('OFFLINE_CHECKPOINT_INVALID');
          if(!lease.cashSessionId) {
            // Older databases had a single open session flag. Match record IDs without reading private plaintext.
            const ids=new Set((await this.db.records.filter(row=>row.kind==='cash-session').toArray()).map(row=>row.id));
            if(ids.size!==1 || !ids.has(sessionId))throw new Error('OFFLINE_CHECKPOINT_INVALID');
          }
        }
        const device=await this.db.device_keys.get('device');
        if(!device || device.revoked)throw new Error('OFFLINE_CHECKPOINT_INVALID');
        await this.db.device_keys.put({...device,closingSessions:[...new Set([...(device.closingSessions ?? []),sessionId])],
          closeCheckpoints:(device.closeCheckpoints ?? []).filter(row=>row.checkpoint.sessionId!==sessionId)});
        await this.db.meta.put({...lease,cashSessionOpen:false,expiresAt:0});
      });
    }finally{await leases.release(lease);}
  }

  async freeze(sessionId: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      throw new Error('OFFLINE_CHECKPOINT_INVALID');
    }
    const leases = new OfflineLease(this.db);
    const lease = await leases.acquire(crypto.randomUUID());
    try {
      await this.db.transaction('rw', [this.db.device_keys, this.db.meta], async () => {
        await leases.assert(lease);
        const device = await this.db.device_keys.get('device');
        if (!device || device.revoked) throw new Error('Dispositivo no autorizado.');
        await this.db.device_keys.put({ ...device,
          closingSessions: [...new Set([...(device.closingSessions ?? []), sessionId])] });
      });
    } finally { await leases.release(lease); }
  }

  async prepare(sessionId: string, drain: () => Promise<void> = async () => {}): Promise<void> {
    await this.freeze(sessionId);
    await drain();
    // Conservatively drain the device queue: no pending operation is hidden by identity.
    if (await this.db.delivery_queue.count()) throw new Error('OFFLINE_PENDING');
  }
}
