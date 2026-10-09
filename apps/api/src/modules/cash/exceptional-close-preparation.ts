import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Money, subtractMoney, validateNonNegativeMoney } from '@uconext/shared';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDeviceError } from './cash-session-device.policy.js';
import { CashCloseError } from './cash-close.service.js';

export const exceptionalCloseInputSchema=z.strictObject({cashSessionId:z.uuid(),confirm:z.literal(true),
  reason:z.string().trim().min(1).max(2000),countedCash:z.string().optional()});

export class ExceptionalClosePreparation {
  async snapshot(client:PoolClient,context:TenantTransactionContext,prepared:Awaited<ReturnType<ExceptionalClosePreparation['prepare']>>) {
    const known=(await client.query<{expected_cash:string;last_seen_at:Date|null;currency_permanently_locked_at:Date|null}>(
      `SELECT (cs.opening_cash+COALESCE((SELECT SUM(delta) FROM cash_movements WHERE organization_id=cs.organization_id
       AND cash_session_id=cs.id),0))::numeric(20,2)::text AS expected_cash,d.last_seen_at,o.currency_permanently_locked_at
       FROM cash_sessions cs JOIN devices d ON d.organization_id=cs.organization_id AND d.id=cs.device_id
       JOIN organizations o ON o.id=cs.organization_id WHERE cs.organization_id=$1 AND cs.id=$2`,
      [context.organizationId,prepared.cashSessionId])).rows[0];
    if (!known) throw new CashCloseError('CASH_CLOSE_STATE_INVALID');
    const operations=(await client.query<{id:string;sequence:string;occurred_at:Date;received_at:Date}>(
      `SELECT id,sequence::text,occurred_at,received_at FROM sync_operations WHERE organization_id=$1
       AND session_id=$2 AND status='ACKED' ORDER BY sequence`,[context.organizationId,prepared.cashSessionId])).rows;
    return Object.freeze({version:1 as const,organizationId:context.organizationId,cashSessionId:prepared.cashSessionId,
      deviceId:prepared.deviceId,currencyCode:prepared.currencyCode,reason:prepared.reason,
      lastContactAt:known.last_seen_at?.toISOString() ?? null,expectedCashKnown:known.expected_cash,countedCash:prepared.countedCash,
      differenceObserved:prepared.countedCash===null ? null:subtractMoney(prepared.countedCash,known.expected_cash),
      operationalDataCompleteness:'UNKNOWN' as const,lateData:'NONE' as const,
      currencyPermanentlyLocked:known.currency_permanently_locked_at!==null,
      operationsReceived:Object.freeze(operations.map(row=>Object.freeze({operationId:row.id,sequence:row.sequence,
        occurredAt:row.occurred_at.toISOString(),receivedAt:row.received_at.toISOString()})))});
  }

  async prepare(client:PoolClient,context:TenantTransactionContext,input:unknown) {
    const request=exceptionalCloseInputSchema.parse(input);
    const amount=request.countedCash===undefined ? undefined : validateNonNegativeMoney(request.countedCash);
    if (request.countedCash!==undefined && amount===undefined) throw new RangeError('El contado no puede ser negativo.');
    await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[context.organizationId]);
    await client.query(`SELECT cr.id FROM cash_registers cr JOIN cash_sessions cs ON cr.organization_id=cs.organization_id AND cr.id=cs.cash_register_id
      WHERE cs.organization_id=$1 AND cs.id=$2 FOR UPDATE OF cr`,[context.organizationId,request.cashSessionId]);
    const session=(await client.query<{id:string;branchId:string;deviceId:string;status:'OPEN'|'CLOSING'|'CONFLICTED';deviceStatus:string;currencyCode:string}>(
      `SELECT cs.id,cs.branch_id AS "branchId",cs.device_id AS "deviceId",cs.status,d.status AS "deviceStatus",cs.currency_code AS "currencyCode"
       FROM cash_sessions cs JOIN devices d ON d.organization_id=cs.organization_id AND d.id=cs.device_id
       WHERE cs.organization_id=$1 AND cs.id=$2 FOR UPDATE OF cs`,[context.organizationId,request.cashSessionId])).rows[0];
    const allowed=await client.query(`SELECT 1 FROM memberships m WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='ACTIVE'
      AND m.revoked_at IS NULL AND (m.role='OWNER' OR m.role='ADMIN' AND EXISTS (SELECT 1 FROM effective_membership_branch_scope s
      WHERE s.organization_id=m.organization_id AND s.membership_id=m.id AND s.branch_id=$3))`,
      [context.organizationId,context.userId,session?.branchId]);
    if (!allowed.rowCount) throw new CashSessionDeviceError('CASH_SESSION_ACTOR_FORBIDDEN','Solo OWNER o ADMIN dentro de alcance puede cerrar excepcionalmente.');
    if (!session || !['OPEN','CLOSING','CONFLICTED'].includes(session.status) || session.deviceStatus!=='UNRECOVERABLE') {
      throw new CashCloseError('CASH_CLOSE_STATE_INVALID');
    }
    return {cashSessionId:session.id,branchId:session.branchId,deviceId:session.deviceId,status:session.status,
      currencyCode:session.currencyCode,reason:request.reason,countedCash:amount===undefined ? null:Money.from(amount).toString()};
  }
}
