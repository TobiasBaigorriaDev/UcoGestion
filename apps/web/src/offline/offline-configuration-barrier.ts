import { z } from 'zod';
import { ApiClient } from '../lib/api/client';
import { OpaqueDelivery } from './opaque-delivery';
import { bytes,base64,unbase64 } from './offline-crypto';
import { OfflineDatabase } from './offline-database';
import { OfflineLease } from './offline-lease';
import type { OfflineAuthorization } from './offline-authorization';
export async function assertOfflineCreation(db:OfflineDatabase):Promise<void> {
  if ((await db.device_keys.get('device'))?.freeze) throw new Error('OFFLINE_CONFIGURATION_FROZEN');
}
export class OfflineConfigurationBarrier {
  constructor(private readonly db:OfflineDatabase,private readonly authorization:OfflineAuthorization) {}
  async freeze(barrier:{id:string;epoch:number}):Promise<void> {
    if (!Number.isSafeInteger(barrier.epoch) || barrier.epoch<1) throw new Error('OFFLINE_CONFIGURATION_FROZEN');
    const leases=new OfflineLease(this.db),lease=await leases.acquire(crypto.randomUUID());
    try {
      await this.db.transaction('rw',[this.db.device_keys,this.db.meta],async()=>{
        await leases.assert(lease);const device=await this.db.device_keys.get('device');
        if (!device || device.freeze && device.freeze.id!==barrier.id) throw new Error('OFFLINE_CONFIGURATION_FROZEN');
        await this.db.device_keys.put({...device,freeze:barrier});
      });
    } finally {await leases.release(lease);}
  }
  async checkpoints(grants?:readonly {id:string;epoch:number}[]) {
    const leases=new OfflineLease(this.db),lease=await leases.acquire(crypto.randomUUID());
    try {
      const device=await this.db.device_keys.get('device');
      if (!device?.freeze) throw new Error('OFFLINE_CONFIGURATION_FROZEN');
      const freeze=device.freeze;
      if (await this.db.delivery_queue.count()) throw new Error('OFFLINE_PENDING');
      const sequence=Number(lease.sequence);
      if (!Number.isSafeInteger(sequence)) throw new Error('OFFLINE_CHECKPOINT_INVALID');
      const headHash=lease.headHash===null ? '0'.repeat(64):Array.from(unbase64(lease.headHash),v=>v.toString(16).padStart(2,'0')).join('');
      return Promise.all([...new Map([...(device.exposures ?? []),...(grants ?? [])].map(row=>[row.id,row])).values()].filter(row=>row.epoch<=freeze.epoch).map(async grant=>{
        const payload=JSON.stringify({organizationId:this.db.organizationId,barrierId:freeze.id,grantId:grant.id,
          epoch:freeze.epoch,sequence,headHash,creationFrozen:true});
        const signature=base64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},device.signingKey,bytes(new TextEncoder().encode(payload)))));
        return {grantId:grant.id,sequence,headHash,signature};
      }));
    } finally {await leases.release(lease);}
  }
  async drainAndSubmit(barrier:{id:string;epoch:number},client:ApiClient=new ApiClient()):Promise<void> {
    await this.freeze(barrier);
    await new OpaqueDelivery(this.db).flush();
    if (await this.db.delivery_queue.count()) throw new Error('OFFLINE_PENDING');
    const grants=await client.request(`/offline/configuration-barriers/${barrier.id}/grants?deviceId=${this.db.deviceId}`,{
      method:'GET',organizationId:this.db.organizationId,parse:value=>z.array(z.object({id:z.uuid(),epoch:z.number().int().positive()})).parse(value)});
    if (!grants) throw new Error('OFFLINE_CHECKPOINT_INVALID');
    const csrf=await client.request('/auth/csrf',{method:'GET',parse:value=>z.object({csrfToken:z.string()}).parse(value)});
    if (!csrf) throw new Error('OFFLINE_CHECKPOINT_INVALID');
    for (const checkpoint of await this.checkpoints(grants)) await client.request(`/offline/configuration-barriers/${barrier.id}/checkpoints`,{
      method:'POST',organizationId:this.db.organizationId,csrfToken:csrf.csrfToken,
      idempotencyKey:`d01-${barrier.id}-${checkpoint.grantId}-${checkpoint.headHash}`,body:checkpoint,
      parse:value=>z.object({recorded:z.literal(true)}).parse(value)});
  }

  async resume(userId:string):Promise<void> {
    const context=await this.authorization.read(userId);
    await this.db.transaction('rw',[this.db.device_keys,this.db.delivery_queue,this.db.records],async()=>{
      const device=await this.db.device_keys.get('device');
      if (!device?.freeze) return;
      const current=await this.db.getEncrypted(userId,'authorization','current');
      if (!current || !context.authorizationBytes || current.length!==context.authorizationBytes.length ||
        current.some((v,i)=>v!==context.authorizationBytes?.[i]) || BigInt(context.claims.epoch)<=BigInt(device.freeze.epoch) || await this.db.delivery_queue.count()) throw new Error('OFFLINE_CONFIGURATION_FROZEN');
      const {freeze,...next}=device;
      if (freeze) await this.db.device_keys.put(next);
    });
  }
}
