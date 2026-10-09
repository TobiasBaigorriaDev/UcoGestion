import { OfflineDatabase } from '../../offline/offline-database';
import { OfflineCloseBarrier } from '../../offline/offline-close';
import { OpaqueDelivery } from '../../offline/opaque-delivery';
import { loadCashCheckpoint } from './cash-api';

export type SignedCashClose=Awaited<ReturnType<OfflineCloseBarrier['checkpoint']>>;
export async function prepareCashClose(organizationId:string,deviceId:string,actorUserId:string,sessionId:string):Promise<SignedCashClose> {
  const db=new OfflineDatabase(organizationId,deviceId);
  try{return await new OfflineCloseBarrier(db).checkpoint(actorUserId,sessionId,()=>loadCashCheckpoint(organizationId,sessionId),
    ()=>new OpaqueDelivery(db).flush());}finally{db.close();}
}
export async function releaseCashAbort(organizationId:string,deviceId:string,sessionId:string,attemptId:string,response:unknown) {
  const db=new OfflineDatabase(organizationId,deviceId);
  try{await new OfflineCloseBarrier(db).releaseAfterAbort(sessionId,attemptId,response);}finally{db.close();}
}
export async function finishCashClose(organizationId:string,deviceId:string,sessionId:string,response:unknown,attemptId?:string) {
  const db=new OfflineDatabase(organizationId,deviceId);
  try{await new OfflineCloseBarrier(db).completeAfterClose(sessionId,response,attemptId);}finally{db.close();}
}
