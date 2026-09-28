import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDevicePolicy } from '../cash/index.js';

export class ExpenseCancellationError extends Error {
  constructor(readonly code: 'EXPENSE_CANCELLATION_REASON_REQUIRED' |
    'EXPENSE_CANCELLATION_NOT_AVAILABLE' | 'EXPENSE_ALREADY_CANCELLED' |
    'EXPENSE_CANCELLATION_FORBIDDEN', message: string) {
    super(message);
    this.name = 'ExpenseCancellationError';
  }
}

export interface PreparedExpenseCancellation {
  readonly id: string;
  readonly expenseId: string;
  readonly branchId: string;
  readonly reason: string;
  readonly method: string;
  readonly amount: string;
  readonly currency: string;
}

export interface ExpenseCancellationCashInput {
  readonly cashSessionId?: string | undefined;
  readonly deviceId?: string | undefined;
}

export interface PreparedExpenseCashReturn {
  readonly cashSessionId: string;
  readonly deviceId: string;
  readonly branchId: string;
  readonly amount: string;
  readonly currency: string;
}

export class ExpenseCancellationPreparation {
  private readonly sessions = new CashSessionDevicePolicy();

  async requireCashReturnSession(client: PoolClient, context: TenantTransactionContext,
    expenseId: string, input: ExpenseCancellationCashInput): Promise<PreparedExpenseCashReturn | null> {
    const found = await client.query<{ branch_id: string; method: string; amount: string;
      currency_code: string }>(`SELECT branch_id, method, amount::text AS amount, currency_code
      FROM expenses WHERE organization_id = $1 AND id = $2`, [context.organizationId, expenseId]);
    const expense = found.rows[0];
    if (!expense) throw new ExpenseCancellationError('EXPENSE_CANCELLATION_NOT_AVAILABLE',
      'El gasto no está disponible.');
    await this.authorize(client, context, expense.branch_id);
    if (expense.method !== 'CASH') {
      if (input.cashSessionId || input.deviceId) throw new ExpenseCancellationError(
        'EXPENSE_CANCELLATION_NOT_AVAILABLE', 'Este gasto no requiere sesión de caja.');
      return null;
    }
    if (!input.cashSessionId || !input.deviceId) throw new ExpenseCancellationError(
      'EXPENSE_CANCELLATION_NOT_AVAILABLE', 'Se requiere una sesión abierta para devolver el efectivo.');
    const session = await this.sessions.requireOperational(client, context.organizationId,
      input.cashSessionId, input.deviceId);
    if (session.branchId !== expense.branch_id) throw new ExpenseCancellationError(
      'EXPENSE_CANCELLATION_NOT_AVAILABLE', 'La sesión pertenece a otra sucursal.');
    const currency = await client.query<{ currency_code: string }>(`SELECT currency_code
      FROM cash_sessions WHERE organization_id = $1 AND id = $2`,
    [context.organizationId, input.cashSessionId]);
    if (currency.rows[0]?.currency_code !== expense.currency_code) throw new ExpenseCancellationError(
      'EXPENSE_CANCELLATION_NOT_AVAILABLE', 'La moneda de la sesión no corresponde al gasto.');
    return { cashSessionId: input.cashSessionId, deviceId: input.deviceId,
      branchId: session.branchId, amount: expense.amount, currency: expense.currency_code };
  }

  async recordCashReturn(client: PoolClient, context: TenantTransactionContext,
    prepared: PreparedExpenseCancellation, cash: PreparedExpenseCashReturn): Promise<void> {
    if (prepared.method !== 'CASH' || prepared.branchId !== cash.branchId
      || prepared.amount !== cash.amount || prepared.currency !== cash.currency) {
      throw new ExpenseCancellationError('EXPENSE_CANCELLATION_NOT_AVAILABLE',
        'La sesión no coincide con el gasto original.');
    }
    await client.query(`INSERT INTO cash_movements (id, organization_id, branch_id,
      cash_session_id, actor_user_id, device_id, delta, currency_code,
      source_type, source_id, effect_kind)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'EXPENSE_CANCELLATION', $9, 'IN')`,
    [randomUUID(), context.organizationId, cash.branchId, cash.cashSessionId,
      context.userId, cash.deviceId, cash.amount, cash.currency, prepared.id]);
  }
  async authorize(client: PoolClient, context: TenantTransactionContext, branchId: string): Promise<void> {
    const allowed = await client.query<{ allowed: boolean }>(`SELECT
      (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope s
        WHERE s.organization_id = m.organization_id AND s.membership_id = m.id
          AND s.branch_id = $3)) AS allowed
      FROM memberships m JOIN branches b ON b.organization_id = m.organization_id AND b.id = $3
      WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE'
        AND m.revoked_at IS NULL AND m.role IN ('OWNER', 'ADMIN') AND b.status = 'ACTIVE'`,
    [context.organizationId, context.userId, branchId]);
    if (!allowed.rows[0]?.allowed) throw new ExpenseCancellationError('EXPENSE_CANCELLATION_FORBIDDEN',
      'No tenés permiso para anular este gasto.');
  }

  async prepare(client: PoolClient, context: TenantTransactionContext,
    expenseId: string, reason: string): Promise<PreparedExpenseCancellation> {
    const normalized = reason.trim();
    if (normalized.length < 1 || normalized.length > 500) {
      throw new ExpenseCancellationError('EXPENSE_CANCELLATION_REASON_REQUIRED',
        'Ingresá un motivo de anulación de hasta 500 caracteres.');
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`expense.cancel:${context.organizationId}:${expenseId}`]);
    const found = await client.query<{ branch_id: string; method: string;
      amount: string; currency_code: string }>(`SELECT branch_id, method, amount::text AS amount,
        currency_code FROM expenses WHERE organization_id = $1 AND id = $2`,
    [context.organizationId, expenseId]);
    const expense = found.rows[0];
    if (!expense) throw new ExpenseCancellationError('EXPENSE_CANCELLATION_NOT_AVAILABLE',
      'El gasto no está disponible.');
    await this.authorize(client, context, expense.branch_id);
    const previous = await client.query(`SELECT 1 FROM expense_cancellations
      WHERE organization_id = $1 AND expense_id = $2`, [context.organizationId, expenseId]);
    if (previous.rowCount) throw new ExpenseCancellationError('EXPENSE_ALREADY_CANCELLED',
      'El gasto ya fue anulado.');
    return { id: randomUUID(), expenseId, branchId: expense.branch_id, reason: normalized,
      method: expense.method, amount: expense.amount, currency: expense.currency_code };
  }

  async record(client: PoolClient, context: TenantTransactionContext,
    prepared: PreparedExpenseCancellation): Promise<void> {
    await client.query(`INSERT INTO expense_cancellations
      (id, organization_id, expense_id, branch_id, actor_user_id, reason,
        method, amount, currency_code, effect_kind)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [prepared.id, context.organizationId, prepared.expenseId, prepared.branchId,
      context.userId, prepared.reason, prepared.method, prepared.amount, prepared.currency,
      prepared.method === 'CASH' ? 'CASH_RETURN' : 'NONCASH_REVERSAL']);
  }
}
