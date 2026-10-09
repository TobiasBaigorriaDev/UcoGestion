import { randomUUID, verify } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Money, subtractMoney, validateNonNegativeMoney } from '@uconext/shared';
import { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDevicePolicy, CashSessionDeviceError } from './cash-session-device.policy.js';
import { retryCashTransaction } from './cash-transaction-retry.js';

const sequenceSchema = z.string().regex(/^(0|[1-9]\d{0,18})$/);
export const cashCloseCheckpointSchema = z.strictObject({
  version: z.literal(1), organizationId: z.uuid(), deviceId: z.uuid(), actorUserId: z.uuid(),
  sessionId: z.uuid(), sequence: sequenceSchema, headHash: z.string().regex(/^[0-9a-f]{64}$/),
  sessionSequence: sequenceSchema, creationFrozen: z.literal(true), pending: z.literal(0),
});
export const cashBeginCloseSchema = z.strictObject({ checkpoint: cashCloseCheckpointSchema,
  signature: z.string().max(128) });
type Checkpoint = z.infer<typeof cashCloseCheckpointSchema>;
const beginResultSchema = z.object({ cashSessionId: z.uuid(), closeAttemptId: z.uuid(), status: z.literal('CLOSING') });
export const cashCloseAttemptSchema = z.strictObject({ cashSessionId: z.uuid(), deviceId: z.uuid(), closeAttemptId: z.uuid() });
const finalSyncResultSchema = z.object({ cashSessionId: z.uuid(), closeAttemptId: z.uuid(), expectedCash: z.string(), ready: z.literal(true) });
export const cashConfirmCloseSchema = cashCloseAttemptSchema.extend({ expectedCash: z.string(), countedCash: z.string(), reason: z.string().max(2000) });
const closeResultSchema = z.object({ cashSessionId: z.uuid(), closeAttemptId: z.uuid(), closureId: z.uuid(),
  status: z.literal('CLOSED'), expectedCash: z.string(), countedCash: z.string(), difference: z.string() });
const abortResultSchema = z.object({ cashSessionId: z.uuid(), closeAttemptId: z.uuid(), status: z.literal('OPEN') });
export const cashReconcileSchema = cashBeginCloseSchema.extend({countedCash:z.string(),reason:z.string().trim().min(1).max(2000)});
const reconcileResultSchema = z.object({cashSessionId:z.uuid(),closureId:z.uuid(),status:z.literal('CLOSED_CONFLICT_RESOLVED'),
  expectedCash:z.string(),countedCash:z.string(),difference:z.string()});

export class CashCloseError extends Error {
  constructor(readonly code: 'CASH_CHECKPOINT_INVALID' | 'CASH_CLOSE_STATE_INVALID') { super(code); }
}

export class CashCloseService {
  constructor(private readonly transactions: TenantTransaction) {}

  async reconcile(context:TenantTransactionContext,input:z.infer<typeof cashReconcileSchema>,key:string) {
    const request=cashReconcileSchema.parse(input), checkpoint=request.checkpoint;
    const amount=validateNonNegativeMoney(request.countedCash);
    if (amount===undefined) throw new RangeError('El contado debe ser mayor o igual a cero.');
    const countedCash=Money.from(amount).toString();
    return retryCashTransaction(()=>this.transactions.runWithOptionalAudit(context,async client=>{
      const row=(await client.query<{branch_id:string;currency_code:string}>(
        'SELECT branch_id,currency_code FROM cash_sessions WHERE organization_id=$1 AND id=$2',
        [context.organizationId,checkpoint.sessionId])).rows[0];
      if (!row) throw new CashCloseError('CASH_CLOSE_STATE_INVALID');
      const policy=new CashSessionDevicePolicy(),idempotency=new IdempotencyService(client);
      const authorize=async()=>{
        const manager=await client.query("SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='ACTIVE' AND revoked_at IS NULL AND role IN ('OWNER','ADMIN')",[context.organizationId,context.userId]);
        if (!manager.rowCount) throw new CashSessionDeviceError('CASH_SESSION_ACTOR_FORBIDDEN','Solo OWNER o ADMIN puede conciliar.');
        return policy.requireAuthorizedActor(client,context,checkpoint.sessionId,checkpoint.deviceId,true);
      };
      const acquired=await idempotency.acquire({actorUserId:context.userId,organizationId:context.organizationId,
        authorizationClass:'CASH_RECONCILE',branchId:row.branch_id,key,scope:'cash.reconcile',payload:{...request,countedCash}},async()=>{await authorize();});
      if (acquired.kind==='replay') return {result:reconcileResultSchema.parse(acquired.response.body)};
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[context.organizationId]);
      await client.query(`SELECT cr.id FROM cash_registers cr JOIN cash_sessions cs ON cr.organization_id=cs.organization_id AND cr.id=cs.cash_register_id
        WHERE cs.organization_id=$1 AND cs.id=$2 FOR UPDATE OF cr`,[context.organizationId,checkpoint.sessionId]);
      const session=await authorize();
      const status=(await client.query<{status:string}>('SELECT status FROM cash_sessions WHERE organization_id=$1 AND id=$2',[context.organizationId,session.id])).rows[0]?.status;
      if (status!=='CONFLICTED') throw new CashCloseError('CASH_CLOSE_STATE_INVALID');
      await this.verifyCheckpoint(client,context,checkpoint,request.signature);
      await this.requireContinuity(client,checkpoint);
      const expectedCash=await this.expected(client,context.organizationId,session.id),difference=subtractMoney(countedCash,expectedCash);
      await client.query(`INSERT INTO cash_session_state_transitions (id,organization_id,cash_session_id,actor_user_id,from_status,to_status)
        VALUES ($1,$2,$3,$4,'CONFLICTED','CLOSED_CONFLICT_RESOLVED')`,[randomUUID(),context.organizationId,session.id,context.userId]);
      const closureId=randomUUID();
      await client.query(`INSERT INTO cash_session_closures (id,organization_id,branch_id,cash_session_id,actor_user_id,expected_cash,counted_cash,difference,currency_code,reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[closureId,context.organizationId,session.branchId,session.id,context.userId,expectedCash,countedCash,difference,row.currency_code,request.reason]);
      if (difference!=='0.00') await client.query('INSERT INTO cash_difference_reviews (id,organization_id,cash_session_id,closure_id,reason) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(),context.organizationId,session.id,closureId,request.reason]);
      const result={cashSessionId:session.id,closureId,status:'CLOSED_CONFLICT_RESOLVED' as const,expectedCash,countedCash,difference};
      await idempotency.complete(acquired.record.id,{statusCode:201,body:result});
      return {result,auditEvent:{action:'cash.session.conflict_resolved',entityType:'cash_session',entityId:session.id,operationId:closureId,
        branchId:session.branchId,deviceId:session.deviceId,before:{status:'CONFLICTED'},after:{...result,reason:request.reason},
        beforeAllowlist:['status'],afterAllowlist:['status','expectedCash','countedCash','difference','reason'],context:{},contextAllowlist:[]}};
    }));
  }

  private async verifyCheckpoint(client:PoolClient,context:TenantTransactionContext,checkpoint:Checkpoint,proof:string) {
    const device=(await client.query<{public_key:string}>('SELECT public_key FROM devices WHERE organization_id=$1 AND id=$2',[context.organizationId,checkpoint.deviceId])).rows[0];
    const signature=Buffer.from(proof,'base64');
    if (checkpoint.organizationId!==context.organizationId || checkpoint.actorUserId!==context.userId || !device?.public_key ||
      signature.length!==64 || signature.toString('base64')!==proof || !verify('sha256',Buffer.from(JSON.stringify(cashCloseCheckpointSchema.parse(checkpoint))),
        {key:device.public_key,dsaEncoding:'ieee-p1363'},signature)) throw new CashCloseError('CASH_CHECKPOINT_INVALID');
  }

  async abort(context: TenantTransactionContext, input: z.infer<typeof cashCloseAttemptSchema>, key: string) {
    const request = cashCloseAttemptSchema.parse(input);
    return retryCashTransaction(() => this.transactions.runWithOptionalAudit(context, async client => {
      const attempt = (await client.query<{ branch_id: string }>(
        `SELECT cs.branch_id FROM cash_close_attempts a JOIN cash_sessions cs
        ON cs.organization_id=a.organization_id AND cs.id=a.cash_session_id
        WHERE a.organization_id=$1 AND a.id=$2 AND a.cash_session_id=$3`,
        [context.organizationId, request.closeAttemptId, request.cashSessionId])).rows[0];
      if (!attempt) throw new CashCloseError('CASH_CLOSE_STATE_INVALID');
      const policy = new CashSessionDevicePolicy(), idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId, organizationId: context.organizationId,
        authorizationClass: 'CASH_ABORT_CLOSE', branchId: attempt.branch_id, key, scope: 'cash.abort-close', payload: request },
      async () => { await policy.requireAuthorizedActor(client, context, request.cashSessionId, request.deviceId, true); });
      if (acquired.kind === 'replay') return { result: abortResultSchema.parse(acquired.response.body) };
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [context.organizationId]);
      await client.query(`SELECT cr.id FROM cash_registers cr JOIN cash_sessions cs
        ON cr.organization_id=cs.organization_id AND cr.id=cs.cash_register_id
        WHERE cs.organization_id=$1 AND cs.id=$2 FOR UPDATE OF cr`, [context.organizationId, request.cashSessionId]);
      const session = await policy.requireAuthorizedActor(client, context, request.cashSessionId, request.deviceId, true);
      await this.requireCurrentAttempt(client, context.organizationId, session.id, request.closeAttemptId);
      // The OPEN transition has no attempt: old counted forms become unusable.
      await client.query(`INSERT INTO cash_session_state_transitions
        (id,organization_id,cash_session_id,actor_user_id,from_status,to_status)
        VALUES ($1,$2,$3,$4,'CLOSING','OPEN')`, [randomUUID(), context.organizationId, session.id, context.userId]);
      const result = { cashSessionId: session.id, closeAttemptId: request.closeAttemptId, status: 'OPEN' as const };
      await idempotency.complete(acquired.record.id, { statusCode: 201, body: result });
      return { result, auditEvent: { action: 'cash.close.aborted', entityType: 'cash_session', entityId: session.id,
        operationId: request.closeAttemptId, branchId: session.branchId, deviceId: session.deviceId,
        before: { status: 'CLOSING' }, after: { status: 'OPEN' }, beforeAllowlist: ['status'], afterAllowlist: ['status'],
        context: { closeAttemptId: request.closeAttemptId }, contextAllowlist: ['closeAttemptId'] } };
    }));
  }

  async close(context: TenantTransactionContext, input: z.infer<typeof cashConfirmCloseSchema>, key: string) {
    const request = cashConfirmCloseSchema.parse(input);
    const amount = validateNonNegativeMoney(request.countedCash);
    if (amount === undefined) throw new RangeError('El contado debe ser mayor o igual a cero.');
    const countedCash = Money.from(amount).toString(), reason = request.reason.trim();
    return retryCashTransaction(() => this.transactions.runWithOptionalAudit(context, async client => {
      const attempt = (await client.query<{ checkpoint: unknown; branch_id: string; currency_code: string }>(
        `SELECT a.checkpoint,cs.branch_id,cs.currency_code FROM cash_close_attempts a JOIN cash_sessions cs
        ON cs.organization_id=a.organization_id AND cs.id=a.cash_session_id
        WHERE a.organization_id=$1 AND a.id=$2 AND a.cash_session_id=$3`,
        [context.organizationId, request.closeAttemptId, request.cashSessionId])).rows[0];
      if (!attempt) throw new CashCloseError('CASH_CLOSE_STATE_INVALID');
      const policy = new CashSessionDevicePolicy(), idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId, organizationId: context.organizationId,
        authorizationClass: 'CASH_CLOSE', branchId: attempt.branch_id, key, scope: 'cash.close', payload: { ...request, countedCash, reason } },
      async () => { await policy.requireAuthorizedActor(client, context, request.cashSessionId, request.deviceId, true); });
      if (acquired.kind === 'replay') return { result: closeResultSchema.parse(acquired.response.body) };
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [context.organizationId]);
      await client.query(`SELECT cr.id FROM cash_registers cr JOIN cash_sessions cs
        ON cr.organization_id=cs.organization_id AND cr.id=cs.cash_register_id
        WHERE cs.organization_id=$1 AND cs.id=$2 FOR UPDATE OF cr`, [context.organizationId, request.cashSessionId]);
      const session = await policy.requireAuthorizedActor(client, context, request.cashSessionId, request.deviceId, true);
      await this.requireCurrentAttempt(client, context.organizationId, session.id, request.closeAttemptId);
      await this.requireContinuity(client, cashCloseCheckpointSchema.parse(attempt.checkpoint));
      const expectedCash = await this.expected(client, context.organizationId, session.id);
      const final = (await client.query<{ expected_cash: string }>(
        'SELECT expected_cash::text FROM cash_final_syncs WHERE organization_id=$1 AND close_attempt_id=$2',
        [context.organizationId, request.closeAttemptId])).rows[0];
      if (!final || final.expected_cash !== expectedCash || request.expectedCash !== expectedCash) throw new CashCloseError('CASH_CHECKPOINT_INVALID');
      const difference = subtractMoney(countedCash, expectedCash);
      if (difference !== '0.00' && !reason) throw new RangeError('La diferencia requiere un motivo.');
      await client.query(`INSERT INTO cash_session_state_transitions
        (id,organization_id,cash_session_id,actor_user_id,from_status,to_status,close_attempt_id)
        VALUES ($1,$2,$3,$4,'CLOSING','CLOSED',$5)`, [randomUUID(), context.organizationId, session.id, context.userId, request.closeAttemptId]);
      const closureId = randomUUID();
      await client.query(`INSERT INTO cash_session_closures
        (id,organization_id,branch_id,cash_session_id,actor_user_id,expected_cash,counted_cash,difference,currency_code,reason,close_attempt_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [closureId, context.organizationId, session.branchId, session.id,
        context.userId, expectedCash, countedCash, difference, attempt.currency_code, reason || null, request.closeAttemptId]);
      if (difference !== '0.00') await client.query(`INSERT INTO cash_difference_reviews
        (id,organization_id,cash_session_id,closure_id,reason) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), context.organizationId, session.id, closureId, reason]);
      const result = { cashSessionId: session.id, closeAttemptId: request.closeAttemptId, closureId,
        status: 'CLOSED' as const, expectedCash, countedCash, difference };
      await idempotency.complete(acquired.record.id, { statusCode: 201, body: result });
      return { result, auditEvent: { action: 'cash.session.closed', entityType: 'cash_session', entityId: session.id,
        operationId: closureId, branchId: session.branchId, deviceId: session.deviceId, before: { status: 'CLOSING' },
        after: { status: 'CLOSED', expectedCash, countedCash, difference, reason }, beforeAllowlist: ['status'],
        afterAllowlist: ['status', 'expectedCash', 'countedCash', 'difference', 'reason'], context: {}, contextAllowlist: [] } };
    }));
  }

  async finalSync(context: TenantTransactionContext, input: z.infer<typeof cashCloseAttemptSchema>, key: string) {
    const request = cashCloseAttemptSchema.parse(input);
    return retryCashTransaction(() => this.transactions.runWithOptionalAudit(context, async client => {
      const attempt = (await client.query<{ checkpoint: unknown; branch_id: string }>(
        `SELECT a.checkpoint,cs.branch_id FROM cash_close_attempts a JOIN cash_sessions cs
        ON cs.organization_id=a.organization_id AND cs.id=a.cash_session_id
        WHERE a.organization_id=$1 AND a.id=$2 AND a.cash_session_id=$3`,
        [context.organizationId, request.closeAttemptId, request.cashSessionId])).rows[0];
      if (!attempt) throw new CashCloseError('CASH_CLOSE_STATE_INVALID');
      const policy = new CashSessionDevicePolicy(), idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId, organizationId: context.organizationId,
        authorizationClass: 'CASH_FINAL_SYNC', branchId: attempt.branch_id, key, scope: 'cash.final-sync', payload: request },
      async () => { await policy.requireAuthorizedActor(client, context, request.cashSessionId, request.deviceId, true); });
      if (acquired.kind === 'replay') return { result: finalSyncResultSchema.parse(acquired.response.body) };
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [context.organizationId]);
      await client.query(`SELECT cr.id FROM cash_registers cr JOIN cash_sessions cs
        ON cr.organization_id=cs.organization_id AND cr.id=cs.cash_register_id
        WHERE cs.organization_id=$1 AND cs.id=$2 FOR UPDATE OF cr`, [context.organizationId, request.cashSessionId]);
      const session = await policy.requireAuthorizedActor(client, context, request.cashSessionId, request.deviceId, true);
      await this.requireCurrentAttempt(client, context.organizationId, request.cashSessionId, request.closeAttemptId);
      const checkpoint = cashCloseCheckpointSchema.parse(attempt.checkpoint);
      await this.requireContinuity(client, checkpoint);
      const expectedCash = await this.expected(client, context.organizationId, request.cashSessionId);
      await client.query(`INSERT INTO cash_final_syncs (organization_id,close_attempt_id,expected_cash)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [context.organizationId, request.closeAttemptId, expectedCash]);
      const result = { cashSessionId: session.id, closeAttemptId: request.closeAttemptId, expectedCash, ready: true as const };
      await idempotency.complete(acquired.record.id, { statusCode: 201, body: result });
      return { result, auditEvent: { action: 'cash.close.final_synced', entityType: 'cash_session', entityId: session.id,
        operationId: request.closeAttemptId, branchId: session.branchId, deviceId: session.deviceId,
        before: {}, after: { expectedCash }, beforeAllowlist: [], afterAllowlist: ['expectedCash'], context: {}, contextAllowlist: [] } };
    }));
  }

  private async requireCurrentAttempt(client: PoolClient, organizationId: string, sessionId: string, attemptId: string) {
    const row = (await client.query<{ status: string; close_attempt_id: string | null }>(
      `SELECT cs.status,t.close_attempt_id FROM cash_sessions cs LEFT JOIN LATERAL
        (SELECT close_attempt_id FROM cash_session_state_transitions WHERE organization_id=cs.organization_id
        AND cash_session_id=cs.id ORDER BY transition_sequence DESC LIMIT 1) t ON true
        WHERE cs.organization_id=$1 AND cs.id=$2`, [organizationId, sessionId])).rows[0];
    if (row?.status !== 'CLOSING' || row.close_attempt_id !== attemptId) throw new CashCloseError('CASH_CLOSE_STATE_INVALID');
  }

  private async expected(client: PoolClient, organizationId: string, sessionId: string): Promise<string> {
    const row = (await client.query<{ expected_cash: string; projection: string }>(
      `SELECT (cs.opening_cash+COALESCE(SUM(cm.delta),0))::numeric(20,2)::text AS expected_cash,cs.expected_cash::text AS projection
       FROM cash_sessions cs LEFT JOIN cash_movements cm ON cm.organization_id=cs.organization_id AND cm.cash_session_id=cs.id
       WHERE cs.organization_id=$1 AND cs.id=$2 GROUP BY cs.id`, [organizationId, sessionId])).rows[0];
    if (!row || row.projection !== row.expected_cash) throw new CashCloseError('CASH_CHECKPOINT_INVALID');
    return row.expected_cash;
  }

  async begin(context: TenantTransactionContext, input: z.infer<typeof cashBeginCloseSchema>, key: string) {
    const request = cashBeginCloseSchema.parse(input);
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new RangeError('Clave de idempotencia inválida.');
    return retryCashTransaction(() => this.transactions.runWithOptionalAudit(context, async client => {
      const checkpoint = request.checkpoint;
      if (checkpoint.organizationId !== context.organizationId || checkpoint.actorUserId !== context.userId) {
        throw new CashCloseError('CASH_CHECKPOINT_INVALID');
      }
      const branch = (await client.query<{ branch_id: string }>(
        'SELECT branch_id FROM cash_sessions WHERE organization_id=$1 AND id=$2',
        [context.organizationId, checkpoint.sessionId])).rows[0];
      if (!branch) throw new CashCloseError('CASH_CLOSE_STATE_INVALID');
      const policy = new CashSessionDevicePolicy();
      const idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId, organizationId: context.organizationId,
        authorizationClass: 'CASH_BEGIN_CLOSE', branchId: branch.branch_id, key, scope: 'cash.begin-close', payload: request },
      async () => { await policy.requireAuthorizedActor(client, context, checkpoint.sessionId, checkpoint.deviceId, true); });
      if (acquired.kind === 'replay') return { result: beginResultSchema.parse(acquired.response.body) };
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [context.organizationId]);
      await client.query(`SELECT cr.id FROM cash_registers cr JOIN cash_sessions cs
        ON cr.organization_id=cs.organization_id AND cr.id=cs.cash_register_id
        WHERE cs.organization_id=$1 AND cs.id=$2 FOR UPDATE OF cr`, [context.organizationId, checkpoint.sessionId]);
      const session = await policy.requireAuthorizedActor(client, context, checkpoint.sessionId, checkpoint.deviceId);
      const device = (await client.query<{ public_key: string }>(
        'SELECT public_key FROM devices WHERE organization_id=$1 AND id=$2', [context.organizationId, checkpoint.deviceId])).rows[0];
      const signature = Buffer.from(request.signature, 'base64');
      // Fixed field order is the versioned wire signature domain, independent of DTO property order.
      const canonical = cashCloseCheckpointSchema.parse(checkpoint);
      if (!device?.public_key || signature.length !== 64 || signature.toString('base64') !== request.signature ||
        !verify('sha256', Buffer.from(JSON.stringify(canonical)), { key: device.public_key, dsaEncoding: 'ieee-p1363' }, signature)) {
        throw new CashCloseError('CASH_CHECKPOINT_INVALID');
      }
      await this.requireContinuity(client, checkpoint);
      const closeAttemptId = randomUUID();
      await client.query(`INSERT INTO cash_close_attempts (id,organization_id,cash_session_id,actor_user_id,checkpoint,signature)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [closeAttemptId, context.organizationId, session.id, context.userId,
        JSON.stringify(canonical), request.signature]);
      await client.query(`INSERT INTO cash_session_state_transitions
        (id,organization_id,cash_session_id,actor_user_id,from_status,to_status,close_attempt_id)
        VALUES ($1,$2,$3,$4,'OPEN','CLOSING',$5)`, [randomUUID(), context.organizationId, session.id, context.userId, closeAttemptId]);
      const result = { cashSessionId: session.id, closeAttemptId, status: 'CLOSING' as const };
      await idempotency.complete(acquired.record.id, { statusCode: 201, body: result });
      return { result, auditEvent: { action: 'cash.close.started', entityType: 'cash_session', entityId: session.id,
        operationId: closeAttemptId, branchId: session.branchId, deviceId: session.deviceId,
        before: { status: 'OPEN' }, after: { status: 'CLOSING', closeAttemptId },
        beforeAllowlist: ['status'], afterAllowlist: ['status', 'closeAttemptId'], context: {}, contextAllowlist: [] } };
    }));
  }

  private async requireContinuity(client: PoolClient, checkpoint: Checkpoint): Promise<void> {
    const rows = (await client.query<{ sequence: string; prev_hash: string; operation_hash: string;
      status: string; session_id: string; session_sequence: string; ack_jws: string | null; delivery_status: string | null }>(
      `SELECT s.sequence::text,s.prev_hash,s.operation_hash,s.status,s.session_id,s.session_sequence::text,
        d.ack_jws,d.status AS delivery_status FROM sync_operations s LEFT JOIN offline_delivery_results d
        ON d.organization_id=s.organization_id AND d.device_id=s.device_id AND d.operation_id=s.id
        WHERE s.organization_id=$1 AND s.device_id=$2 ORDER BY s.sequence`,
      [checkpoint.organizationId, checkpoint.deviceId])).rows;
    if (BigInt(rows.length) !== BigInt(checkpoint.sequence)) throw new CashCloseError('CASH_CHECKPOINT_INVALID');
    let previous = '0'.repeat(64), sequence = 0n, sessionSequence = 0n;
    for (const row of rows) {
      sequence++;
      if (BigInt(row.sequence) !== sequence || row.prev_hash !== previous || row.status !== 'ACKED' ||
        row.delivery_status !== 'ACKED' || !row.ack_jws) throw new CashCloseError('CASH_CHECKPOINT_INVALID');
      previous = row.operation_hash;
      if (row.session_id === checkpoint.sessionId && BigInt(row.session_sequence) !== ++sessionSequence) {
        throw new CashCloseError('CASH_CHECKPOINT_INVALID');
      }
    }
    if (previous !== checkpoint.headHash || sessionSequence !== BigInt(checkpoint.sessionSequence)) {
      throw new CashCloseError('CASH_CHECKPOINT_INVALID');
    }
  }
}
