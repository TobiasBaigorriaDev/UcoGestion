import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDevicePolicy } from '../cash/index.js';
import { PurchasePolicy } from './purchase-policy.js';

export class PurchaseCancellationError extends Error {
  constructor(readonly code: 'PURCHASE_CANCELLATION_REASON_REQUIRED' |
    'PURCHASE_CANCELLATION_NOT_AVAILABLE' | 'PURCHASE_ALREADY_CANCELLED' |
    'PURCHASE_CANCELLATION_STOCK_INSUFFICIENT', message: string) {
    super(message);
    this.name = 'PurchaseCancellationError';
  }
}

export interface PreparedPurchaseCancellation {
  readonly id: string;
  readonly purchaseId: string;
  readonly branchId: string;
  readonly currency: string;
  readonly reason: string;
  readonly previousStatus: 'PAID' | 'PENDING_PAYMENT';
}

export interface PurchaseCancellationCashInput {
  readonly cashSessionId?: string | undefined;
  readonly deviceId?: string | undefined;
}

export interface PreparedPurchaseCashReturn {
  readonly cashSessionId: string;
  readonly deviceId: string;
  readonly branchId: string;
  readonly amount: string;
  readonly currency: string;
}

export class PurchaseCancellationPreparation {
  private readonly policy = new PurchasePolicy();
  private readonly sessions = new CashSessionDevicePolicy();

  async requireCashReturnSession(client: PoolClient, context: TenantTransactionContext,
    purchaseId: string, input: PurchaseCancellationCashInput): Promise<PreparedPurchaseCashReturn | null> {
    const found = await client.query<{ branch_id: string; method: string | null;
      amount: string | null; currency_code: string }>(`SELECT p.branch_id, pp.method,
        pp.amount::text AS amount, p.currency_code FROM purchases p
        LEFT JOIN purchase_payments pp ON pp.organization_id = p.organization_id
          AND pp.purchase_id = p.id
        WHERE p.organization_id = $1 AND p.id = $2`, [context.organizationId, purchaseId]);
    const purchase = found.rows[0];
    if (!purchase) throw new PurchaseCancellationError('PURCHASE_CANCELLATION_NOT_AVAILABLE',
      'La compra no está disponible.');
    await this.policy.authorize(client, context, purchase.branch_id, 'CANCEL');
    if (purchase.method !== 'CASH') return null;
    if (!input.cashSessionId || !input.deviceId || !purchase.amount) {
      throw new PurchaseCancellationError('PURCHASE_CANCELLATION_NOT_AVAILABLE',
        'Se requiere una sesión abierta para devolver el pago en efectivo.');
    }
    const session = await this.sessions.requireOperational(client, context.organizationId,
      input.cashSessionId, input.deviceId);
    if (session.branchId !== purchase.branch_id) throw new PurchaseCancellationError(
      'PURCHASE_CANCELLATION_NOT_AVAILABLE', 'La sesión pertenece a otra sucursal.');
    const currency = await client.query<{ currency_code: string }>(`SELECT currency_code
      FROM cash_sessions WHERE organization_id = $1 AND id = $2`,
    [context.organizationId, input.cashSessionId]);
    if (currency.rows[0]?.currency_code !== purchase.currency_code) throw new PurchaseCancellationError(
      'PURCHASE_CANCELLATION_NOT_AVAILABLE', 'La moneda de la sesión no corresponde a la compra.');
    return { cashSessionId: input.cashSessionId, deviceId: input.deviceId,
      branchId: session.branchId, amount: purchase.amount, currency: purchase.currency_code };
  }

  async prepare(client: PoolClient, context: TenantTransactionContext, purchaseId: string,
    reason: string): Promise<PreparedPurchaseCancellation> {
    const normalized = reason.trim();
    if (normalized.length < 1 || normalized.length > 500) {
      throw new PurchaseCancellationError('PURCHASE_CANCELLATION_REASON_REQUIRED',
        'Ingresá un motivo de anulación de hasta 500 caracteres.');
    }
    const locked = await client.query<{ branch_id: string; currency_code: string;
      confirmation_status: 'PAID' | 'PENDING_PAYMENT'; has_payment: boolean }>(
      `SELECT p.branch_id, p.currency_code, p.confirmation_status,
        EXISTS (SELECT 1 FROM purchase_payments pp WHERE pp.organization_id = p.organization_id
          AND pp.purchase_id = p.id) AS has_payment
       FROM purchases p WHERE p.organization_id = $1 AND p.id = $2 FOR UPDATE OF p`,
      [context.organizationId, purchaseId]);
    const purchase = locked.rows[0];
    if (!purchase) throw new PurchaseCancellationError('PURCHASE_CANCELLATION_NOT_AVAILABLE',
      'La compra no está disponible.');
    await this.policy.authorize(client, context, purchase.branch_id, 'CANCEL');
    const previous = await client.query('SELECT 1 FROM purchase_cancellations WHERE organization_id = $1 AND purchase_id = $2',
      [context.organizationId, purchaseId]);
    if (previous.rowCount) throw new PurchaseCancellationError('PURCHASE_ALREADY_CANCELLED',
      'La compra ya fue anulada.');
    return { id: randomUUID(), purchaseId, branchId: purchase.branch_id,
      currency: purchase.currency_code, reason: normalized,
      previousStatus: purchase.confirmation_status === 'PAID' || purchase.has_payment
        ? 'PAID' : 'PENDING_PAYMENT' };
  }

  async record(client: PoolClient, context: TenantTransactionContext,
    prepared: PreparedPurchaseCancellation): Promise<void> {
    await client.query(`INSERT INTO purchase_cancellations
      (id, organization_id, purchase_id, branch_id, actor_user_id, reason)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [prepared.id, context.organizationId, prepared.purchaseId, prepared.branchId,
      context.userId, prepared.reason]);
  }

  async reverseStock(client: PoolClient, context: TenantTransactionContext,
    prepared: PreparedPurchaseCancellation): Promise<void> {
    try {
      await client.query('SELECT inventory_api.reverse_purchase_stock($1, $2, $3, $4)',
        [context.organizationId, prepared.purchaseId, prepared.id, context.userId]);
    } catch (error) {
      if (error instanceof Object && 'code' in error && error.code === 'P1640') {
        throw new PurchaseCancellationError('PURCHASE_CANCELLATION_STOCK_INSUFFICIENT',
          'No hay stock suficiente para anular todos los productos de la compra.');
      }
      throw error;
    }
  }

  async reversePayment(client: PoolClient, context: TenantTransactionContext,
    prepared: PreparedPurchaseCancellation, cash: PreparedPurchaseCashReturn | null): Promise<void> {
    const payment = await client.query<{ id: string; method: string; amount: string;
      currency_code: string }>(`SELECT id, method, amount::text AS amount, currency_code
      FROM purchase_payments WHERE organization_id = $1 AND purchase_id = $2`,
    [context.organizationId, prepared.purchaseId]);
    const historical = payment.rows[0];
    if (!historical) return;
    if (historical.method === 'CASH' && (!cash || cash.amount !== historical.amount
      || cash.currency !== historical.currency_code || cash.branchId !== prepared.branchId)) {
      throw new PurchaseCancellationError('PURCHASE_CANCELLATION_NOT_AVAILABLE',
        'Se requiere una sesión válida para devolver el pago en efectivo.');
    }
    await client.query(`INSERT INTO purchase_payment_reversals (id, organization_id,
      purchase_id, cancellation_id, purchase_payment_id, method, amount, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), context.organizationId, prepared.purchaseId, prepared.id, historical.id,
      historical.method, historical.amount, historical.currency_code]);
  }

  async recordCashReturn(client: PoolClient, context: TenantTransactionContext,
    prepared: PreparedPurchaseCancellation, cash: PreparedPurchaseCashReturn): Promise<void> {
    await client.query(`INSERT INTO cash_movements (id, organization_id, branch_id,
      cash_session_id, actor_user_id, device_id, delta, currency_code,
      source_type, source_id, effect_kind)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PURCHASE_CANCELLATION', $9, 'IN')`,
    [randomUUID(), context.organizationId, cash.branchId, cash.cashSessionId,
      context.userId, cash.deviceId, cash.amount, cash.currency, prepared.id]);
  }
}
