import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { IdempotencyService, toJsonValue } from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { ExceptionalClosePreparation, exceptionalCloseInputSchema } from './exceptional-close-preparation.js';
import { CashSessionDeviceError } from './cash-session-device.policy.js';
import { retryCashTransaction } from './cash-transaction-retry.js';

const resultSchema=z.object({cashSessionId:z.uuid(),closureId:z.uuid(),status:z.literal('CLOSED_WITH_UNRECOVERED_DEVICE')});

export class ExceptionalCashCloseService {
  constructor(private readonly transactions:TenantTransaction) {}

  async close(context:TenantTransactionContext,input:z.infer<typeof exceptionalCloseInputSchema>,key:string) {
    const request=exceptionalCloseInputSchema.parse(input);
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new RangeError('Clave de idempotencia inválida.');
    return retryCashTransaction(()=>this.transactions.runWithOptionalAudit(context,async client=>{
      const branch=(await client.query<{branch_id:string}>(
        'SELECT branch_id FROM cash_sessions WHERE organization_id=$1 AND id=$2',[context.organizationId,request.cashSessionId])).rows[0];
      if (!branch) throw new CashSessionDeviceError('CASH_SESSION_ACTOR_FORBIDDEN','Sesión no disponible.');
      const authorize=async()=>{
        const allowed=await client.query(`SELECT 1 FROM memberships m WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='ACTIVE'
          AND m.revoked_at IS NULL AND (m.role='OWNER' OR m.role='ADMIN' AND EXISTS (SELECT 1 FROM effective_membership_branch_scope s
          WHERE s.organization_id=m.organization_id AND s.membership_id=m.id AND s.branch_id=$3))`,[context.organizationId,context.userId,branch.branch_id]);
        if (!allowed.rowCount) throw new CashSessionDeviceError('CASH_SESSION_ACTOR_FORBIDDEN','No podés cerrar excepcionalmente esta sesión.');
      };
      await authorize();
      const idempotency=new IdempotencyService(client);
      const acquired=await idempotency.acquire({actorUserId:context.userId,organizationId:context.organizationId,branchId:branch.branch_id,
        authorizationClass:'CASH_EXCEPTIONAL_CLOSE',key,scope:'cash.exceptional-close',payload:toJsonValue(request)},authorize);
      if (acquired.kind==='replay') return {result:resultSchema.parse(acquired.response.body)};
      const preparation=new ExceptionalClosePreparation();
      const prepared=await preparation.prepare(client,context,request);
      const snapshot=await preparation.snapshot(client,context,prepared);
      await client.query(`INSERT INTO cash_session_state_transitions (id,organization_id,cash_session_id,actor_user_id,from_status,to_status)
        VALUES ($1,$2,$3,$4,$5,'CLOSED_WITH_UNRECOVERED_DEVICE')`,[randomUUID(),context.organizationId,request.cashSessionId,context.userId,prepared.status]);
      const closureId=randomUUID();
      await client.query(`INSERT INTO cash_exceptional_closures (id,organization_id,branch_id,cash_session_id,actor_user_id,snapshot)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,[closureId,context.organizationId,prepared.branchId,request.cashSessionId,context.userId,JSON.stringify(snapshot)]);
      const result={cashSessionId:request.cashSessionId,closureId,status:'CLOSED_WITH_UNRECOVERED_DEVICE' as const};
      await idempotency.complete(acquired.record.id,{statusCode:201,body:result});
      return {result,auditEvent:{action:'cash.session.closed_exceptionally',entityType:'cash_session',entityId:request.cashSessionId,
        operationId:closureId,branchId:prepared.branchId,deviceId:prepared.deviceId,before:{status:prepared.status},
        after:{status:result.status,expectedCashKnown:snapshot.expectedCashKnown,countedCash:snapshot.countedCash,reason:prepared.reason,completeness:'UNKNOWN'},
        beforeAllowlist:['status'],afterAllowlist:['status','expectedCashKnown','countedCash','reason','completeness'],context:{},contextAllowlist:[]}};
    }));
  }
}
