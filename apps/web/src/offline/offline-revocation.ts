import { revocationCheckpointPayload,type RevocationCheckpoint } from '@uconext/shared';
import { base64,bytes,unbase64 } from './offline-crypto';
import { OfflineDatabase } from './offline-database';
import type { OfflineKeys } from './offline-keys';
import { OfflineLease } from './offline-lease';
import { announceIdentityRetirement } from './identity-retirement-events';
export async function assertOfflineIdentity(db:OfflineDatabase,userId:string,requireCredential = false):Promise<void> {
  const device=await db.device_keys.get('device');
  if ((await db.meta.get('device-chain'))?.deviceRevoked || device?.revoked || device?.revokedUsers?.includes(userId)) throw new Error('OFFLINE_REVOKED');
  if (device?.retiredUsers?.includes(userId)) throw new Error('Identidad offline bloqueada. Reautenticación online requerida.');
  if (requireCredential && !await db.key_envelopes.get(userId)) throw new Error('Identidad offline bloqueada.');
}
export class OfflineRevocation {
  constructor(private readonly db:OfflineDatabase,private readonly keys:OfflineKeys) {}
  async learn(actorUserId:string|null):Promise<RevocationCheckpoint> {
    this.keys.lockDevice();
    const leases=new OfflineLease(this.db),lease=await leases.acquire(crypto.randomUUID());
    try {
      const device=await this.db.device_keys.get('device');
      if (!device) throw new Error('Dispositivo no autorizado.');
      const existing=device.knowledge?.find(row=>row.actorUserId===actorUserId);
      if (existing) {this.retireAccess();return existing;}
      const headHash=lease.headHash===null ? '0'.repeat(64):Array.from(unbase64(lease.headHash),v=>v.toString(16).padStart(2,'0')).join('');
      const value={organizationId:this.db.organizationId,deviceId:this.db.deviceId,actorUserId,sequence:lease.sequence,headHash};
      const signature=base64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},device.signingKey,bytes(new TextEncoder().encode(revocationCheckpointPayload(value))))));
      const checkpoint={...value,signature};
      await this.db.transaction('rw',[this.db.device_keys,this.db.meta],async()=>{
        await leases.assert(lease);
        const current=await this.db.device_keys.get('device');if (!current) throw new Error('Dispositivo no autorizado.');
        await this.db.device_keys.put({...current,...(actorUserId===null ? {revoked:true}:{revokedUsers:[...new Set([...(current.revokedUsers ?? []),actorUserId])]}),knowledge:[...(current.knowledge ?? []),checkpoint]});
      });
      this.retireAccess();return checkpoint;
    } finally {await leases.release(lease);}
  }
  private retireAccess(): void {
    this.keys.lockDevice();
    if (typeof window !== 'undefined') {
      announceIdentityRetirement();
      window.dispatchEvent(new Event('uco:delivery-request'));
    }
  }
}
