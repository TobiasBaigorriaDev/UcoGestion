import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { Money, validatePositiveMoney } from '@uconext/shared';
import { z } from 'zod';

import { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashOpeningError, CashOpeningPreparation, type CashOpeningInput } from './cash-opening-preparation.js';
import { CashSessionDevicePolicy } from './cash-session-device.policy.js';
import { retryCashTransaction } from './cash-transaction-retry.js';

const openResultSchema = z.object({
  id: z.uuid(), branchId: z.uuid(), cashRegisterId: z.uuid(), deviceId: z.uuid(),
  ownerUserId: z.uuid(), openingCash: z.string(), currencyCode: z.string(),
});
export type CashOpenResult = z.infer<typeof openResultSchema>;
export interface ManualCashInput {
  readonly cashSessionId: string;
  readonly deviceId: string;
  readonly amount: string;
  readonly reason: string;
}
const manualResultSchema = z.object({ id: z.uuid(), cashSessionId: z.uuid(),
  actorUserId: z.uuid(), deviceId: z.uuid(), amount: z.string(), expectedCash: z.string() });
export type ManualCashResult = z.infer<typeof manualResultSchema>;
export class CashMovementError extends Error {
  constructor(readonly code: 'CASH_INSUFFICIENT_EXPECTED', message: string) {
    super(message);
    this.name = 'CashMovementError';
  }
}

export class CashOperationsService {
  private readonly opening = new CashOpeningPreparation();
  private readonly devicePolicy = new CashSessionDevicePolicy();

  constructor(private readonly transactions: TenantTransaction) {}

  async open(context: TenantTransactionContext, input: CashOpeningInput, key: string): Promise<CashOpenResult> {
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new RangeError('La clave de idempotencia es inválida.');
    return retryCashTransaction(() => this.transactions.runWithOptionalAudit(context, async (client) => {
      await this.authorizeOpening(client, context, input);
      const idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId,
        authorizationClass: 'CASH_OPEN', branchId: input.branchId, key,
        organizationId: context.organizationId, payload: { branchId: input.branchId,
          cashRegisterId: input.cashRegisterId, deviceId: input.deviceId,
          openingCash: input.openingCash }, scope: 'cash.session.open',
      }, async () => this.authorizeOpening(client, context, input));
      if (acquired.kind === 'replay') return { result: openResultSchema.parse(acquired.response.body) };
      const prepared = await this.opening.prepare(client, context, input);
      const id = randomUUID();
      await client.query(`INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id,
        owner_user_id, device_id, origin, status, opening_cash, expected_cash, currency_code)
        VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', $7, $7, $8)`,
      [id, context.organizationId, prepared.branchId, prepared.cashRegisterId,
        context.userId, prepared.deviceId, prepared.openingCash, prepared.currencyCode]);
      const result: CashOpenResult = { id, branchId: prepared.branchId,
        cashRegisterId: prepared.cashRegisterId, deviceId: prepared.deviceId,
        ownerUserId: context.userId, openingCash: prepared.openingCash,
        currencyCode: prepared.currencyCode };
      await idempotency.complete(acquired.record.id, { statusCode: 201, body: result });
      return { result, auditEvent: { action: 'cash.session.opened', entityType: 'cash_session',
        entityId: id, operationId: id, branchId: prepared.branchId, deviceId: prepared.deviceId,
        before: {}, beforeAllowlist: [], after: { openingCash: prepared.openingCash },
        afterAllowlist: ['openingCash'], context: {}, contextAllowlist: [] } };
    }));
  }

  async deposit(context: TenantTransactionContext, input: ManualCashInput,
    key: string): Promise<ManualCashResult> {
    return this.recordManual(context, 'IN', input, key);
  }

  async withdraw(context: TenantTransactionContext, input: ManualCashInput,
    key: string): Promise<ManualCashResult> {
    return this.recordManual(context, 'OUT', input, key);
  }

  async calculateExpectedCash(context: TenantTransactionContext, cashSessionId: string,
    deviceId: string): Promise<{ cashSessionId: string; expectedCash: string }> {
    return retryCashTransaction(() => this.transactions.runWithOptionalAudit(context, async (client) => {
      const session = await this.devicePolicy.requireAuthorizedActor(client, context,
        cashSessionId, deviceId);
      const calculated = await client.query<{ expected_cash: string }>(
        `SELECT (cs.opening_cash + COALESCE(SUM(cm.delta), 0))::numeric(20,2) AS expected_cash
         FROM cash_sessions cs LEFT JOIN cash_movements cm
           ON cm.organization_id = cs.organization_id AND cm.cash_session_id = cs.id
         WHERE cs.organization_id = $1 AND cs.id = $2
         GROUP BY cs.id, cs.opening_cash`, [context.organizationId, session.id]);
      const expectedCash = calculated.rows.at(0)?.expected_cash;
      if (expectedCash === undefined) {
        throw new CashOpeningError('CASH_OPENING_REGISTER_NOT_AVAILABLE', 'La sesión no está disponible.');
      }
      return { result: { cashSessionId: session.id, expectedCash } };
    }));
  }

  private async recordManual(context: TenantTransactionContext, direction: 'IN' | 'OUT',
    input: ManualCashInput, key: string): Promise<ManualCashResult> {
    const amount = validatePositiveMoney(input.amount);
    if (amount === undefined) throw new RangeError('El importe debe ser estrictamente positivo.');
    const canonicalAmount = Money.from(amount).toString();
    const reason = input.reason.trim();
    if (reason.length < 1 || reason.length > 2000) throw new RangeError('El motivo es obligatorio.');
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new RangeError('La clave de idempotencia es inválida.');
    return retryCashTransaction(() => this.transactions.runWithOptionalAudit(context, async (client) => {
      const session = await client.query<{ branch_id: string }>(
        'SELECT branch_id FROM cash_sessions WHERE organization_id = $1 AND id = $2',
        [context.organizationId, input.cashSessionId]);
      const branchId = session.rows.at(0)?.branch_id;
      if (!branchId) throw new CashOpeningError('CASH_OPENING_REGISTER_NOT_AVAILABLE', 'La sesión no está disponible.');
      const idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId,
        authorizationClass: `CASH_MANUAL_${direction}`, branchId, key, organizationId: context.organizationId,
        payload: { cashSessionId: input.cashSessionId, deviceId: input.deviceId,
          amount: canonicalAmount, reason }, scope: `cash.movement.manual.${direction.toLowerCase()}`,
      }, async () => { await this.devicePolicy.requireAuthorizedActor(client, context,
        input.cashSessionId, input.deviceId, true); });
      if (acquired.kind === 'replay') return { result: manualResultSchema.parse(acquired.response.body) };
      const authorized = await this.devicePolicy.requireAuthorizedActor(client, context,
        input.cashSessionId, input.deviceId);
      if (direction === 'OUT') {
        const sufficient = await client.query<{ sufficient: boolean }>(
          `SELECT expected_cash >= $3::numeric AS sufficient FROM cash_sessions
           WHERE organization_id = $1 AND id = $2`,
          [context.organizationId, input.cashSessionId, canonicalAmount]);
        if (!sufficient.rows.at(0)?.sufficient) {
          throw new CashMovementError('CASH_INSUFFICIENT_EXPECTED',
            'El efectivo esperado es insuficiente. Registrá un ingreso o usá otra sesión válida.');
        }
      }
      const currency = await client.query<{ currency_code: string }>(
        'SELECT currency_code FROM cash_sessions WHERE organization_id = $1 AND id = $2',
        [context.organizationId, input.cashSessionId]);
      const id = randomUUID();
      await client.query(`INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id,
        actor_user_id, device_id, delta, currency_code, source_type, source_id, effect_kind, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'MANUAL', $1, $10, $9)`,
      [id, context.organizationId, authorized.branchId, authorized.id, authorized.actorUserId,
        authorized.deviceId, direction === 'IN' ? canonicalAmount : `-${canonicalAmount}`,
        currency.rows[0]?.currency_code, reason, direction]);
      const projection = await client.query<{ expected_cash: string }>(
        'SELECT expected_cash FROM cash_sessions WHERE organization_id = $1 AND id = $2',
        [context.organizationId, input.cashSessionId]);
      const expectedCash = projection.rows.at(0)?.expected_cash;
      if (expectedCash === undefined) {
        throw new CashOpeningError('CASH_OPENING_REGISTER_NOT_AVAILABLE', 'La sesión no está disponible.');
      }
      const result: ManualCashResult = { id, cashSessionId: authorized.id,
        actorUserId: authorized.actorUserId, deviceId: authorized.deviceId,
        amount: canonicalAmount, expectedCash };
      await idempotency.complete(acquired.record.id, { statusCode: 201, body: result });
      return { result, auditEvent: { action: direction === 'IN' ? 'cash.manual.deposit' : 'cash.manual.withdrawal', entityType: 'cash_movement',
        entityId: id, operationId: id, branchId: authorized.branchId,
        deviceId: authorized.deviceId, before: {}, beforeAllowlist: [],
        after: { amount: canonicalAmount, reason }, afterAllowlist: ['amount', 'reason'],
        context: { cashSessionId: authorized.id }, contextAllowlist: ['cashSessionId'] } };
    }));
  }

  private async authorizeOpening(client: PoolClient, context: TenantTransactionContext,
    input: CashOpeningInput): Promise<void> {
    const membership = await client.query<{ id: string; role: string }>(
      `SELECT id, role FROM memberships WHERE organization_id = $1 AND user_id = $2
       AND status = 'ACTIVE' AND revoked_at IS NULL`, [context.organizationId, context.userId]);
    const actor = membership.rows.at(0);
    if (!actor || !['OWNER', 'ADMIN', 'CASHIER'].includes(actor.role)) {
      throw new CashOpeningError('CASH_OPENING_FORBIDDEN', 'El usuario no puede abrir esta caja.');
    }
    const register = await client.query<{ branch_id: string }>(
      `SELECT branch_id FROM cash_registers WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'`,
      [context.organizationId, input.cashRegisterId]);
    if (register.rows.at(0)?.branch_id !== input.branchId) {
      throw new CashOpeningError('CASH_OPENING_REGISTER_NOT_AVAILABLE', 'La caja no está disponible.');
    }
    const device = await client.query(`SELECT 1 FROM devices WHERE organization_id = $1 AND id = $2
      AND branch_id = $3 AND status = 'ACTIVE'`, [context.organizationId, input.deviceId, input.branchId]);
    if (!device.rowCount) throw new CashOpeningError('CASH_OPENING_DEVICE_NOT_AVAILABLE', 'El dispositivo no está disponible.');
    if (actor.role !== 'OWNER') {
      const scope = await client.query<{ allowed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM effective_membership_branch_scope
         WHERE organization_id = $1 AND membership_id = $2 AND branch_id = $3) AS allowed`,
        [context.organizationId, actor.id, input.branchId]);
      if (!scope.rows.at(0)?.allowed) {
        throw new CashOpeningError('CASH_OPENING_FORBIDDEN', 'La caja queda fuera del alcance del usuario.');
      }
    }
  }
}
