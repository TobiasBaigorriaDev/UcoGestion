import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction,type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDeviceError } from './cash-session-device.policy.js';
import { CashCloseError } from './cash-close.service.js';
import { retryCashTransaction } from './cash-transaction-retry.js';

export const lateCashReviewSchema=z.strictObject({cashSessionId:z.uuid(),throughOperationId:z.uuid(),note:z.string().max(2000)});
const resultSchema=z.object({cashSessionId:z.uuid(),throughOperationId:z.uuid(),status:z.literal('REVIEWED'),reviewedAt:z.string()});
export class LateCashReviewService {
  constructor(private readonly transactions:TenantTransaction) {}

  async review(context:TenantTransactionContext,cashSessionId:string,throughOperationId:string,note:string,key:string) {
    const input=lateCashReviewSchema.parse({cashSessionId,throughOperationId,note:note.trim()});
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new RangeError('Clave de idempotencia inválida.');
    return retryCashTransaction(()=>this.transactions.runWithOptionalAudit(context,async client=>{
      const session=(await client.query<{branch_id:string}>(
        'SELECT branch_id FROM cash_sessions WHERE organization_id=$1 AND id=$2',[context.organizationId,cashSessionId])).rows[0];
      if (!session) throw new CashSessionDeviceError('CASH_SESSION_ACTOR_FORBIDDEN','Sesión no disponible.');
      const authorize=async()=>{
        const allowed=await client.query(`SELECT 1 FROM memberships m WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='ACTIVE'
          AND m.revoked_at IS NULL AND (m.role='OWNER' OR m.role='ADMIN' AND EXISTS (SELECT 1 FROM effective_membership_branch_scope s
          WHERE s.organization_id=m.organization_id AND s.membership_id=m.id AND s.branch_id=$3))`,[context.organizationId,context.userId,session.branch_id]);
        if (!allowed.rowCount) throw new CashSessionDeviceError('CASH_SESSION_ACTOR_FORBIDDEN','Solo OWNER o ADMIN dentro de alcance puede revisar recuperaciones.');
      };
      await authorize();
      const idempotency=new IdempotencyService(client);
      const acquired=await idempotency.acquire({actorUserId:context.userId,organizationId:context.organizationId,branchId:session.branch_id,
        authorizationClass:'CASH_LATE_REVIEW',key,scope:'cash.late-review',payload:input},authorize);
      if (acquired.kind==='replay') return {result:resultSchema.parse(acquired.response.body)};
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[context.organizationId]);
      await client.query('SELECT id FROM cash_sessions WHERE organization_id=$1 AND id=$2 FOR UPDATE',[context.organizationId,cashSessionId]);
      await authorize();
      const latest=(await client.query<{operation_id:string}>(`SELECT r.operation_id FROM cash_late_recoveries r JOIN sync_operations s
        ON s.organization_id=r.organization_id AND s.id=r.operation_id WHERE r.organization_id=$1 AND r.cash_session_id=$2 ORDER BY s.sequence DESC LIMIT 1`,
      [context.organizationId,cashSessionId])).rows[0];
      if (latest?.operation_id!==throughOperationId) throw new CashCloseError('CASH_CLOSE_STATE_INVALID');
      const prior=await client.query('SELECT 1 FROM cash_late_reviews WHERE organization_id=$1 AND cash_session_id=$2 AND through_operation_id=$3',
        [context.organizationId,cashSessionId,throughOperationId]);
      if (prior.rowCount) throw new CashCloseError('CASH_CLOSE_STATE_INVALID');
      const row=(await client.query<{reviewed_at:Date}>(`INSERT INTO cash_late_reviews
        (id,organization_id,cash_session_id,through_operation_id,reviewer_user_id,note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING reviewed_at`,
      [randomUUID(),context.organizationId,cashSessionId,throughOperationId,context.userId,input.note])).rows[0];
      if (!row) throw new Error('Revisión no persistida.');
      const result={cashSessionId,throughOperationId,status:'REVIEWED' as const,reviewedAt:row.reviewed_at.toISOString()};
      await idempotency.complete(acquired.record.id,{statusCode:201,body:result});
      return {result,auditEvent:{action:'cash.late_operations_reviewed',entityType:'cash_session',entityId:cashSessionId,operationId:throughOperationId,
        branchId:session.branch_id,before:{review:'PENDING_REVIEW'},after:{review:'REVIEWED',note:input.note},beforeAllowlist:['review'],
        afterAllowlist:['review','note'],context:{throughOperationId},contextAllowlist:['throughOperationId']}};
    }));
  }
}
