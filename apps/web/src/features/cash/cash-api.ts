import { z } from 'zod';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import { canonical, bytes, unbase64 } from '../../offline/offline-crypto';
import { OfflineDatabase } from '../../offline/offline-database';
import { closeChainSchema } from '../../offline/offline-close';

export const cashSessionSchema=z.object({id:z.uuid(),cashRegisterId:z.uuid(),registerName:z.string(),deviceId:z.uuid(),
  status:z.enum(['OPEN','CLOSING','CONFLICTED','CLOSED','CLOSED_CONFLICT_RESOLVED','CLOSED_WITH_UNRECOVERED_DEVICE']),
  openingCash:z.string(),expectedCash:z.string(),currencyCode:z.string(),openedAt:z.iso.datetime(),
  deviceStatus:z.string().optional(),completeness:z.string().optional(),currencyPermanentlyLocked:z.boolean().optional(),
  exceptionalClosure:z.object({expectedCashKnown:z.string(),countedCash:z.string().nullable(),differenceObserved:z.string().nullable(),
    lastContactAt:z.string().nullable(),reason:z.string(),operationsReceived:z.array(z.object({operationId:z.uuid(),sequence:z.string(),occurredAt:z.string(),receivedAt:z.string()}))}).nullable().optional(),
  lateData:z.object({marker:z.literal('LATE_RECOVERED_OPERATIONS'),throughOperationId:z.uuid(),sequence:z.string(),receivedAt:z.string(),count:z.string(),
    status:z.enum(['PENDING_REVIEW','REVIEWED'])}).nullable().optional(),
  chain:closeChainSchema.optional(),closeAttemptId:z.uuid().nullable().optional(),lastAbortedAttemptId:z.uuid().nullable().optional(),
  finalSync:z.object({ready:z.literal(true),expectedCash:z.string()}).nullable().optional(),
  closure:z.object({expectedCash:z.string(),countedCash:z.string(),difference:z.string(),reason:z.string().nullable()}).nullable().optional(),
  differenceReview:z.object({id:z.uuid(),status:z.enum(['PENDING_REVIEW','REVIEWED']),selfReview:z.boolean(),canReview:z.boolean()}).nullable().optional()});
export const cashWorkspaceSchema=z.object({actorUserId:z.uuid(),registers:z.array(z.object({id:z.uuid(),name:z.string(),available:z.boolean()})),
  devices:z.array(z.object({id:z.uuid(),status:z.string(),publicKey:z.string().nullable().optional()})),sessions:z.array(cashSessionSchema),
  nextCursor:z.string().nullable().optional()});
export type CashWorkspaceData=z.infer<typeof cashWorkspaceSchema>;
export type CashSession=z.infer<typeof cashSessionSchema>;
const api=new ApiClient();
export type CashView='ACTIVE'|'FINAL'|'PENDING_REVIEW';
export async function loadCashWorkspace(organizationId:string,branchId:string,options:{view?:CashView;cursor?:string;sessionId?:string}={}):Promise<CashWorkspaceData> {
  const params=new URLSearchParams({branchId,view:options.view ?? 'ACTIVE',...(options.cursor ? {cursor:options.cursor}:{}),
    ...(options.sessionId?{sessionId:options.sessionId}:{})});
  const data=await api.request(`/cash-sessions?${params}`,{method:'GET',organizationId,parse:v=>cashWorkspaceSchema.parse(v)});
  if (!data) throw new Error('Cash workspace unavailable');
  return data;
}
export async function loadCashSession(organizationId:string,branchId:string,sessionId:string):Promise<CashSession> {
  const row=(await loadCashWorkspace(organizationId,branchId,{sessionId})).sessions.find(session=>session.id===sessionId);
  if(!row)throw new Error('CASH_CLOSE_STATE_INVALID');return row;
}
export async function loadCashCheckpoint(organizationId:string,sessionId:string) {
  const data=await api.request(`/cash-sessions/${encodeURIComponent(sessionId)}/checkpoint`,{method:'GET',organizationId,parse:v=>closeChainSchema.parse(v)});
  if(!data)throw new Error('OFFLINE_CHECKPOINT_INVALID');return data;
}
export async function cashCommand(organizationId:string,path:string,body:unknown,key:string):Promise<unknown> {
  const csrf=await api.request('/auth/csrf',{method:'GET',parse:v=>z.object({csrfToken:z.string()}).parse(v)});
  if (!csrf) throw new Error('CSRF unavailable');
  return api.request(`/cash-sessions/${path}`,{method:'POST',organizationId,body,idempotencyKey:key,csrfToken:csrf.csrfToken,parse:v=>{
    if(path==='open') return z.object({id:z.uuid(),branchId:z.uuid(),cashRegisterId:z.uuid(),deviceId:z.uuid(),ownerUserId:z.uuid(),
      openingCash:z.string(),currencyCode:z.string()}).parse(v);
    if(path==='manual-deposits' || path==='manual-withdrawals') return z.object({id:z.uuid(),cashSessionId:z.uuid(),actorUserId:z.uuid(),
      deviceId:z.uuid(),amount:z.string(),expectedCash:z.string()}).parse(v);
    return v;
  }});
}

export function cashRejectionIsDefinitive(cause:unknown):boolean {
  return cause instanceof ApiProblemError && cause.status>=400 && cause.status<500 && cause.status!==408 && cause.status!==429
    && !['IDEMPOTENCY_REPLAY_PENDING','CASH_RETRY_PENDING'].includes(cause.code);
}

const pendingSchema=z.strictObject({key:z.uuid(),hash:z.string().regex(/^[0-9a-f]{64}$/)});
/** Only an opaque retry key/hash persist. Amounts, motives and business data are never cached here. */
export class CashCommandRetry {
  constructor(private readonly partition:string,private readonly store:Storage=localStorage) {}
  private slot(path:string) {return `uco-cash-retry:${this.partition}:${path}`;}
  async key(path:string,body:unknown):Promise<string> {
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(body)));
    const hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    const stored=this.store.getItem(this.slot(path));
    if (stored) {
      const pending=pendingSchema.parse(JSON.parse(stored));
      if (pending.hash!==hash) throw new ApiProblemError({status:409,code:'CASH_RETRY_PENDING',
        message:'Hay una respuesta pendiente. Reingresá los mismos datos y reintentá antes de iniciar otra operación.'});
      return pending.key;
    }
    const pending={key:crypto.randomUUID(),hash};
    this.store.setItem(this.slot(path),JSON.stringify(pending));return pending.key;
  }
  complete(path:string) {this.store.removeItem(this.slot(path));}
}

export async function findLocalCashDevice(organizationId:string,devices:CashWorkspaceData['devices']):Promise<string|undefined> {
  const names=await OfflineDatabase.getDatabaseNames();
  for (const device of devices) {
    if (device.status!=='ACTIVE' || !device.publicKey || !names.includes(OfflineDatabase.nameFor(organizationId,device.id))) continue;
    const db=new OfflineDatabase(organizationId,device.id);
    try {
      const local=await db.device_keys.get('device');
      if (!local || local.revoked) continue;
      const key=await crypto.subtle.importKey('spki',bytes(unbase64(device.publicKey.replace(/-----[^-]+-----|\s/g,''))),
        {name:'ECDSA',namedCurve:'P-256'},false,['verify']);
      const challenge=crypto.getRandomValues(new Uint8Array(32));
      const proof=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},local.signingKey,challenge);
      if (await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,proof,challenge)) return device.id;
    } finally {db.close();}
  }
  return undefined;
}
