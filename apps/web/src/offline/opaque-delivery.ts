import { offlineAckClaimsSchema, offlineAckHeaderSchema } from '@uconext/shared';
import { base64, bytes, unbase64 } from './offline-crypto';
import { OfflineDatabase } from './offline-database';
const encoder=new TextEncoder();
async function hex(value:Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes(value))),v=>v.toString(16).padStart(2,'0')).join('');
}
export class OpaqueDelivery {
  private running:Promise<void>|undefined;
  constructor(private readonly db:OfflineDatabase,private readonly fetcher:typeof fetch=(input,init)=>fetch(input,init)) {}
  pendingBytes() { return this.db.deliveryBytes(); }
  async signChallenge(challenge:Uint8Array):Promise<Uint8Array> {
    const domain=encoder.encode('UcoNext:delivery-challenge:v1:');
    const payload=new Uint8Array(domain.length+challenge.length);payload.set(domain);payload.set(challenge,domain.length);
    return this.signProof(payload);
  }
  private async signProof(challenge:Uint8Array):Promise<Uint8Array> {
    const device=await this.db.device_keys.get('device');
    if (!device) throw new Error('Dispositivo no autorizado.');
    return new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},device.signingKey,bytes(challenge)));
  }
  flush():Promise<void> {
    if (this.running) return this.running;
    this.running=this.send().finally(()=>{this.running=undefined;});return this.running;
  }
  private async send():Promise<void> {
    let progressed=true;
    while (progressed) {
      progressed=false;
      const stored=await this.pendingBytes();
      for (const row of stored) if (row.ack && await this.acceptAck(row.ack,stored)) progressed=true;
      const pending=await this.pendingBytes();
      const groups=new Map<string,typeof pending>();
      for (const row of pending) {
        const routing:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(row.envelope));
        if (!routing || typeof routing!=='object' || !('certificate' in routing) || typeof routing.certificate!=='string') throw new Error('OFFLINE_ENVELOPE_INVALID');
        groups.set(routing.certificate,[...(groups.get(routing.certificate) ?? []),row]);
      }
      for (const [certificate,rows] of groups) {
        for (let offset=0;offset<rows.length;offset+=50) {
          const batch=rows.slice(offset,offset+50),envelopes=batch.map(row=>new TextDecoder('utf-8',{fatal:true}).decode(row.envelope));
          const challengeResponse=await this.fetcher('/api/v1/offline/delivery/challenge',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({certificate}),cache:'no-store'});
          if (!challengeResponse.ok) throw new Error('OFFLINE_DELIVERY_UNAVAILABLE');
          const challenge:unknown=(await challengeResponse.json()).challenge;
          if (typeof challenge!=='string') throw new Error('OFFLINE_DELIVERY_UNAVAILABLE');
          const checkpoints=(await this.db.device_keys.get('device'))?.knowledge;
          const proofPayload=JSON.stringify({domain:'UcoNext:delivery:v1',challenge,batchHash:await hex(encoder.encode(JSON.stringify(envelopes))),...(checkpoints ? {checkpointHash:await hex(encoder.encode(JSON.stringify(checkpoints)))}: {})});
          const proof=base64(await this.signProof(encoder.encode(proofPayload)));
          const response=await this.fetcher('/api/v1/offline/delivery/push',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({certificate,challenge,envelopes,proof,...(checkpoints ? {checkpoints}: {})}),cache:'no-store'});
          if (!response.ok) throw new Error('OFFLINE_DELIVERY_UNAVAILABLE');
          const result:unknown=await response.json();
          if (!result || typeof result!=='object' || !('acks' in result) || !Array.isArray(result.acks)) throw new Error('OFFLINE_ACK_INVALID');
          for (const ack of result.acks) {
            if (typeof ack!=='string') throw new Error('OFFLINE_ACK_INVALID');
            if (await this.acceptAck(ack,batch)) progressed=true;
          }
        }
      }
    }
  }
  async acceptAck(jwt:string,pending:readonly {id:string;envelope:Uint8Array}[]):Promise<boolean> {
    const [header,body,signature,...extra]=jwt.split('.');
    if (!header || !body || !signature || extra.length || jwt.length>2048) throw new Error('OFFLINE_ACK_INVALID');
    const decode=(value:string)=>unbase64(value.replace(/-/g,'+').replace(/_/g,'/'));
    const metadata=offlineAckHeaderSchema.parse(JSON.parse(new TextDecoder().decode(decode(header))));
    const claims=offlineAckClaimsSchema.parse(JSON.parse(new TextDecoder().decode(decode(body))));
    const row=pending.find(item=>item.id===claims.operationId);
    const device=await this.db.device_keys.get('device'), key=device?.ackKeys?.[metadata.kid];
    const sig=decode(signature);
    if (!row || !key || claims.keyId!==metadata.kid || sig.length!==64 ||
      base64(sig).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')!==signature ||
      claims.envelopeHash!==await hex(row.envelope) || !await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,bytes(sig),bytes(encoder.encode(`${header}.${body}`)))) throw new Error('OFFLINE_ACK_INVALID');
    return this.db.transaction('rw',[this.db.delivery_queue,this.db.records,this.db.device_keys,this.db.key_envelopes,this.db.pin_attempts,this.db.meta],async()=>{
      const current=await this.db.delivery_queue.get(row.id);
      if (!current) return false;
      if (current.envelope.length!==row.envelope.length || current.envelope.some((v,i)=>v!==row.envelope[i])) throw new Error('OFFLINE_ACK_INVALID');
      await this.db.records.filter(record=>record.kind==='operation' && record.id===row.id).delete();
      await this.db.delivery_queue.delete(row.id);
      if (await this.db.delivery_queue.count()===0) {
        const currentDevice=await this.db.device_keys.get('device');
        if (currentDevice?.revoked) {
          await this.db.records.clear();await this.db.key_envelopes.clear();await this.db.pin_attempts.clear();await this.db.device_keys.clear();
          const chain=await this.db.meta.get('device-chain');
          await this.db.meta.clear();
          await this.db.meta.put({...chain,key:'device-chain',owner:'revoked',fence:chain?.fence ?? '0',expiresAt:0,sequence:chain?.sequence ?? '0',headHash:chain?.headHash ?? null,deviceRevoked:true});
        } else for (const userId of currentDevice?.revokedUsers ?? []) {
          await this.db.records.filter(record=>record.userId===userId).delete();await this.db.key_envelopes.delete(userId);await this.db.pin_attempts.delete(userId);
        }
      }
      return true;
    });
  }
}
export function startOpaqueDelivery(deliver:()=>Promise<void>,target:Window=window,page:Document=document):()=>void {
  let stopped=false,running=false,requested=false;
  const trigger=()=>{
    requested=true;
    if (running || stopped) return;
    running=true;
    void (async()=>{
      while (requested && !stopped) { requested=false;try {await deliver();} catch {target.dispatchEvent(new Event('uco:delivery-pending'));} }
    })().finally(()=>{running=false;});
  };
  const visible=()=>{if (page.visibilityState==='visible') trigger();};
  target.addEventListener('online',trigger);target.addEventListener('uco:sync',trigger);target.addEventListener('uco:delivery-request',trigger);
  page.addEventListener('visibilitychange',visible);trigger();
  return ()=>{stopped=true;target.removeEventListener('online',trigger);target.removeEventListener('uco:sync',trigger);target.removeEventListener('uco:delivery-request',trigger);page.removeEventListener('visibilitychange',visible);};
}
export async function deliverAllOpaqueDatabases():Promise<void> {
  const names=await OfflineDatabase.getDatabaseNames();
  const results=await Promise.allSettled(names.filter(name=>name.startsWith('uconext-offline-')).map(async name=>{
    const match=/^uconext-offline-([0-9a-f-]{36})-([0-9a-f-]{36})$/i.exec(name);
    if (!match?.[1] || !match[2]) return;
    const db=new OfflineDatabase(match[1],match[2]);
    try {await db.open();await new OpaqueDelivery(db).flush();} finally {db.close();}
  }));
  if (results.some(result=>result.status==='rejected')) throw new Error('OFFLINE_DELIVERY_UNAVAILABLE');
}
