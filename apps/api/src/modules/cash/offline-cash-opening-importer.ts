import { parseUtcTimestamp } from '@uconext/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { AuditEventWriter } from '../../core/audit/audit-event-writer.js';
import { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';

const inputSchema = z.strictObject({ id: z.uuid(), operationId: z.uuid(), organizationId: z.uuid(), actorUserId: z.uuid(),
  deviceId: z.uuid(), branchId: z.uuid(), cashRegisterId: z.uuid(), grantId: z.uuid(),
  openingCash: z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/), currency: z.string().regex(/^[A-Z]{3}$/), openedAt: z.string() });
const resultSchema = z.strictObject({ id: z.uuid(), status: z.enum(['OPEN', 'CONFLICTED']) });

/** Public application port for historically validated opening snapshots. No HTTP
 * route exposes this command. The ingesting module validates envelope/grant/order
 * before calling it on the SAME contextual transaction and writes the definitive
 * sync receipt there. A resolved result becomes an ACK only after that commit. */
export class OfflineCashOpeningImporter {
  async apply(client: PoolClient, context: TenantTransactionContext, input: unknown) {
    const request = inputSchema.parse(input);
    const openedAt = parseUtcTimestamp(request.openedAt);
    const authorize = async () => {
      if (request.organizationId !== context.organizationId || request.actorUserId !== context.userId) throw new Error('OFFLINE_OPENING_SCOPE_INVALID');
      const resource = await client.query<{ branch_id: string; status: string; branch_status: string }>(
        `SELECT cr.branch_id, cr.status, b.status AS branch_status FROM cash_registers cr
         JOIN branches b ON b.organization_id=cr.organization_id AND b.id=cr.branch_id
         WHERE cr.organization_id=$1 AND cr.id=$2 FOR UPDATE OF cr`, [context.organizationId, request.cashRegisterId]);
      const row = resource.rows[0];
      if (!row || row.branch_id !== request.branchId) throw new Error('OFFLINE_OPENING_SCOPE_INVALID');
      return row;
    };
    const register = await authorize();
    const idempotency = new IdempotencyService(client);
    const acquired = await idempotency.acquire({ organizationId: context.organizationId, actorUserId: context.userId,
      authorizationClass: 'OFFLINE_CASH_OPEN', scope: 'offline.cash.open', branchId: request.branchId,
      key: request.operationId, payload: request }, async () => { await authorize(); });
    if (acquired.kind === 'replay') return resultSchema.parse(acquired.response.body);
    const active = await client.query(`SELECT id FROM cash_sessions WHERE organization_id=$1 AND cash_register_id=$2
      AND status IN ('OPEN','CLOSING','CONFLICTED') FOR UPDATE`, [context.organizationId, request.cashRegisterId]);
    const status = active.rowCount || register.status !== 'ACTIVE' || register.branch_status !== 'ACTIVE' ? 'CONFLICTED' : 'OPEN';
    await client.query(`INSERT INTO cash_sessions (id,organization_id,branch_id,cash_register_id,owner_user_id,device_id,
      origin,status,opening_cash,expected_cash,currency_code,opened_at)
      VALUES ($1,$2,$3,$4,$5,$6,'OFFLINE',$7,$8,$8,$9,$10)`, [request.id, context.organizationId, request.branchId,
      request.cashRegisterId, context.userId, request.deviceId, status, request.openingCash, request.currency, openedAt]);
    const result = { id: request.id, status };
    await idempotency.complete(acquired.record.id, { statusCode: 200, body: result });
    await new AuditEventWriter(client).append({ action: 'cash.session.opened.offline', entityType: 'cash_session', entityId: request.id,
      operationId: request.operationId, organizationId: context.organizationId, actorUserId: context.userId, requestId: context.requestId,
      branchId: request.branchId, deviceId: request.deviceId, before: {}, beforeAllowlist: [],
      after: { status, openingCash: request.openingCash }, afterAllowlist: ['status','openingCash'],
      context: { grantId: request.grantId }, contextAllowlist: ['grantId'] });
    return resultSchema.parse(result);
  }
}
