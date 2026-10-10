import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDevicePolicy } from '../cash/index.js';
import { reverseSaleStock } from '../inventory/index.js';

export class SaleCancellationError extends Error {
  constructor(readonly code: 'SALE_CANCELLATION_FORBIDDEN' | 'SALE_CANCELLATION_REASON_REQUIRED' |
    'SALE_CANCELLATION_NOT_AVAILABLE' | 'SALE_ALREADY_CANCELLED', message: string) {
    super(message);
    this.name = 'SaleCancellationError';
  }
}

export interface PreparedSaleCancellation {
  readonly cancellationId: string;
  readonly saleId: string;
  readonly branchId: string;
  readonly currencyCode: string;
  readonly reason: string;
}

export interface PreparedCashRefund {
  readonly cashSessionId: string;
  readonly deviceId: string;
  readonly branchId: string;
  readonly amount: string;
  readonly currencyCode: string;
}

export class SaleCashRefundError extends Error {
  constructor(readonly code: 'SALE_REFUND_SESSION_REQUIRED' | 'SALE_REFUND_BRANCH_CONFLICT' |
    'SALE_REFUND_CASH_INSUFFICIENT', message: string) {
    super(message); this.name = 'SaleCashRefundError';
  }
}

export class SaleCancellationPreparation {
  async requireCashRefundSession(client: PoolClient, context: TenantTransactionContext,
    saleId: string, cashSessionId?: string, deviceId?: string): Promise<PreparedCashRefund | null> {
    const original = await client.query<{ branch_id: string; currency_code: string;
      cash_amount: string }>(`SELECT s.branch_id, s.currency_code,
        COALESCE(SUM(p.applied_amount) FILTER (WHERE p.method = 'CASH'), 0)::numeric(20,2)::text
          AS cash_amount
        FROM sales s LEFT JOIN sale_payments p
          ON p.organization_id = s.organization_id AND p.sale_id = s.id
        WHERE s.organization_id = $1 AND s.id = $2
        GROUP BY s.id, s.branch_id, s.currency_code`,
    [context.organizationId, saleId]);
    const sale = original.rows[0];
    if (!sale) throw new SaleCancellationError('SALE_CANCELLATION_NOT_AVAILABLE',
      'La venta no está disponible.');
    if (sale.cash_amount === '0.00') return null;
    if (!cashSessionId || !deviceId) throw new SaleCashRefundError('SALE_REFUND_SESSION_REQUIRED',
      'Se requiere una sesión abierta para reintegrar efectivo.');
    const session = await new CashSessionDevicePolicy().requireAuthorizedActor(client, context,
      cashSessionId, deviceId);
    if (session.branchId !== sale.branch_id) throw new SaleCashRefundError('SALE_REFUND_BRANCH_CONFLICT',
      'La sesión de reintegro pertenece a otra sucursal.');
    const available = await client.query<{ enough: boolean }>(`SELECT expected_cash >= $3::numeric
        AND currency_code = $4 AS enough FROM cash_sessions
        WHERE organization_id = $1 AND id = $2`,
    [context.organizationId, cashSessionId, sale.cash_amount, sale.currency_code]);
    if (!available.rows[0]?.enough) throw new SaleCashRefundError('SALE_REFUND_CASH_INSUFFICIENT',
      'El efectivo esperado no alcanza para reintegrar la venta.');
    return { cashSessionId, deviceId, branchId: session.branchId, amount: sale.cash_amount,
      currencyCode: sale.currency_code };
  }

  async prepare(client: PoolClient, context: TenantTransactionContext, saleId: string,
    reason: string): Promise<PreparedSaleCancellation> {
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 1 || normalizedReason.length > 500) {
      throw new SaleCancellationError('SALE_CANCELLATION_REASON_REQUIRED', 'Ingresá un motivo de anulación.');
    }
    const sale = await client.query<{ branch_id: string; currency_code: string }>(
      `SELECT branch_id, currency_code FROM sales WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [context.organizationId, saleId]);
    const record = sale.rows[0];
    if (!record) throw new SaleCancellationError('SALE_CANCELLATION_NOT_AVAILABLE',
      'La venta no está disponible.');
    const authorized = await client.query<{ allowed: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM memberships m WHERE m.organization_id = $1 AND m.user_id = $2
        AND m.status = 'ACTIVE' AND m.revoked_at IS NULL AND m.role IN ('OWNER', 'ADMIN')
        AND (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope scope
          WHERE scope.organization_id = m.organization_id AND scope.membership_id = m.id
            AND scope.branch_id = $3))) AS allowed`,
    [context.organizationId, context.userId, record.branch_id]);
    if (!authorized.rows[0]?.allowed) throw new SaleCancellationError('SALE_CANCELLATION_FORBIDDEN',
      'No tenés permiso para anular esta venta.');
    const existing = await client.query('SELECT 1 FROM sale_cancellations WHERE organization_id = $1 AND sale_id = $2',
      [context.organizationId, saleId]);
    if (existing.rowCount) throw new SaleCancellationError('SALE_ALREADY_CANCELLED',
      'La venta ya fue anulada.');
    return { cancellationId: randomUUID(), saleId, branchId: record.branch_id,
      currencyCode: record.currency_code, reason: normalizedReason };
  }

  async record(client: PoolClient, context: TenantTransactionContext,
    cancellation: PreparedSaleCancellation): Promise<void> {
    await client.query(`INSERT INTO sale_cancellations
      (id, organization_id, sale_id, branch_id, actor_user_id, reason)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [cancellation.cancellationId, context.organizationId, cancellation.saleId,
      cancellation.branchId, context.userId, cancellation.reason]);
  }

  async reverseStock(client: PoolClient, context: TenantTransactionContext,
    cancellation: PreparedSaleCancellation): Promise<void> {
    await reverseSaleStock(client,context,cancellation.saleId,cancellation.cancellationId);
  }

  async refund(client: PoolClient, context: TenantTransactionContext,
    cancellation: PreparedSaleCancellation): Promise<void> {
    const payments = await client.query<{ id: string; method: string; applied_amount: string;
      currency_code: string }>(`SELECT id, method, applied_amount, currency_code FROM sale_payments
        WHERE organization_id = $1 AND sale_id = $2 ORDER BY id`,
    [context.organizationId, cancellation.saleId]);
    for (const payment of payments.rows) {
      await client.query(`INSERT INTO sale_refunds (id, organization_id, sale_id,
        cancellation_id, sale_payment_id, method, amount, currency_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), context.organizationId, cancellation.saleId, cancellation.cancellationId,
        payment.id, payment.method, payment.applied_amount, payment.currency_code]);
    }
  }

  async recordCashRefund(client: PoolClient, context: TenantTransactionContext,
    cancellation: PreparedSaleCancellation, cash: PreparedCashRefund): Promise<void> {
    if (cash.branchId !== cancellation.branchId || cash.currencyCode !== cancellation.currencyCode) {
      throw new SaleCashRefundError('SALE_REFUND_BRANCH_CONFLICT', 'La sesión no corresponde a la venta.');
    }
    await client.query(`INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id,
      actor_user_id, device_id, delta, currency_code, source_type, source_id, effect_kind)
      VALUES ($1, $2, $3, $4, $5, $6, -($7::numeric), $8, 'SALE_CANCELLATION', $9, 'OUT')`,
    [randomUUID(), context.organizationId, cash.branchId, cash.cashSessionId,
      context.userId, cash.deviceId, cash.amount, cash.currencyCode, cancellation.cancellationId]);
  }
}
