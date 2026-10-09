import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { retryCashTransaction } from './cash-transaction-retry.js';
import { CashSessionDeviceError } from './cash-session-device.policy.js';

const resultSchema = z.object({ id: z.uuid(), status: z.literal('REVIEWED'), mode: z.enum(['REVIEW','SELF_REVIEW']),
  reviewerUserId: z.uuid(), reviewedAt: z.string() });
export class CashDifferenceReviewError extends Error {
  readonly code = 'CASH_SELF_REVIEW_FORBIDDEN';
  constructor() { super('CASH_SELF_REVIEW_FORBIDDEN'); }
}
export class CashDifferenceReviewService {
  constructor(private readonly transactions: TenantTransaction) {}

  async review(context: TenantTransactionContext, reviewId: string, note: string, key: string) {
    z.uuid().parse(reviewId);
    const normalizedNote = z.string().max(2000).parse(note).trim();
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new RangeError('Clave de idempotencia inválida.');
    return retryCashTransaction(() => this.transactions.runWithOptionalAudit(context, async client => {
      const row = (await client.query<{ branch_id: string; cash_session_id: string; actor_user_id: string }>(
        `SELECT c.branch_id,r.cash_session_id,c.actor_user_id FROM cash_difference_reviews r
         JOIN cash_session_closures c ON c.organization_id=r.organization_id AND c.id=r.closure_id
         WHERE r.organization_id=$1 AND r.id=$2`, [context.organizationId,reviewId])).rows[0];
      if (!row) throw new CashSessionDeviceError('CASH_SESSION_ACTOR_FORBIDDEN','Diferencia no disponible.');
      const authorize = async () => {
        const allowed = await client.query(`SELECT 1 FROM memberships m WHERE m.organization_id=$1 AND m.user_id=$2
          AND m.status='ACTIVE' AND m.revoked_at IS NULL AND (m.role='OWNER' OR m.role='ADMIN' AND EXISTS
          (SELECT 1 FROM effective_membership_branch_scope s WHERE s.organization_id=m.organization_id
           AND s.membership_id=m.id AND s.branch_id=$3))`, [context.organizationId,context.userId,row.branch_id]);
        if (!allowed.rowCount) throw new CashSessionDeviceError('CASH_SESSION_ACTOR_FORBIDDEN','No podés revisar esta diferencia.');
      };
      await authorize();
      const idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId, organizationId: context.organizationId,
        authorizationClass:'CASH_DIFFERENCE_REVIEW',branchId:row.branch_id,key,scope:'cash.difference.review',
        payload:{reviewId,note:normalizedNote} },authorize);
      if (acquired.kind==='replay') return {result:resultSchema.parse(acquired.response.body)};
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[context.organizationId]);
      await client.query('SELECT id FROM cash_sessions WHERE organization_id=$1 AND id=$2 FOR UPDATE',[context.organizationId,row.cash_session_id]);
      await authorize();
      const prior = await client.query('SELECT 1 FROM cash_difference_review_events WHERE organization_id=$1 AND review_id=$2',[context.organizationId,reviewId]);
      if (prior.rowCount) throw new RangeError('La diferencia ya está revisada.');
      const mode = row.actor_user_id===context.userId ? 'SELF_REVIEW' as const : 'REVIEW' as const;
      if (mode==='SELF_REVIEW') {
        const alternate = await client.query(`SELECT 1 FROM memberships m WHERE m.organization_id=$1 AND m.user_id<>$2
          AND m.status='ACTIVE' AND m.revoked_at IS NULL AND (m.role='OWNER' OR m.role='ADMIN' AND EXISTS
          (SELECT 1 FROM effective_membership_branch_scope s WHERE s.organization_id=m.organization_id
           AND s.membership_id=m.id AND s.branch_id=$3)) LIMIT 1`,[context.organizationId,context.userId,row.branch_id]);
        if (alternate.rowCount) throw new CashDifferenceReviewError();
        if (!normalizedNote) throw new RangeError('La autorrevisión requiere justificación.');
      }
      const event = (await client.query<{reviewed_at:Date}>(`INSERT INTO cash_difference_review_events
        (id,organization_id,review_id,reviewer_user_id,mode,note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING reviewed_at`,
      [randomUUID(),context.organizationId,reviewId,context.userId,mode,normalizedNote])).rows[0];
      if (!event) throw new Error('Revisión no persistida.');
      const result = { id:reviewId,status:'REVIEWED' as const,mode,reviewerUserId:context.userId,reviewedAt:event.reviewed_at.toISOString() };
      await idempotency.complete(acquired.record.id,{statusCode:201,body:result});
      return {result,auditEvent:{action:'cash.difference.reviewed',entityType:'cash_difference_review',entityId:reviewId,
        operationId:reviewId,branchId:row.branch_id,before:{status:'PENDING_REVIEW'},after:{status:'REVIEWED',mode,note:normalizedNote},
        beforeAllowlist:['status'],afterAllowlist:['status','mode','note'],context:{cashSessionId:row.cash_session_id},contextAllowlist:['cashSessionId']}};
    }));
  }
}
