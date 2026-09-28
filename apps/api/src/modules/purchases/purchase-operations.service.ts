import { randomUUID } from 'node:crypto';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { validatePositiveMoney } from '@uconext/shared';
import type { PoolClient } from 'pg';

import { IdempotencyService, toJsonValue } from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDevicePolicy } from '../cash/index.js';
import { PurchaseCancellationError, PurchaseCancellationPreparation,
  type PurchaseCancellationCashInput } from './purchase-cancellation-preparation.js';
import { PurchasePersistence, type PurchaseLineInput } from './purchase-persistence.js';
import { PurchasePolicy } from './purchase-policy.js';

export interface ConfirmPendingPurchaseInput {
  readonly branchId: string;
  readonly supplierId: string;
  readonly clientOperationId: string;
  readonly lines: readonly PurchaseLineInput[];
}

export interface ConfirmPendingPurchaseResult {
  readonly id: string;
  readonly status: 'PENDING_PAYMENT';
  readonly total: string;
  readonly currency: string;
}

export interface PurchasePaymentInput {
  readonly method: string;
  readonly amount: string;
  readonly cashSessionId?: string | undefined;
  readonly deviceId?: string | undefined;
}
export class PurchaseCashBalanceError extends Error {
  readonly code = 'CASH_INSUFFICIENT_EXPECTED' as const;
  constructor() { super('El efectivo esperado es insuficiente. Registrá un ingreso o usá otra sesión válida.'); }
}

export class ConcurrentPurchaseModificationError extends Error {
  readonly code = 'PURCHASE_CONCURRENT_MODIFICATION' as const;
  constructor() { super('La compra encontró una modificación concurrente. Intentá nuevamente.'); }
}

export class PurchasePaymentError extends Error {
  readonly code = 'PURCHASE_PAYMENT_INVALID' as const;
  constructor() { super('El pago de la compra debe cubrir exactamente el total con un medio disponible.'); }
}

export class PurchaseOperationsService {
  private readonly policy = new PurchasePolicy();
  private readonly persistence = new PurchasePersistence();
  private readonly sessions = new CashSessionDevicePolicy();
  private readonly cancellations = new PurchaseCancellationPreparation();
  constructor(private readonly transactions: TenantTransaction) {}

  async detail(context: TenantTransactionContext, purchaseId: string) {
    return this.transactions.read(context, async (client) => {
      const found = await client.query<{ id: string; branch_id: string; actor_user_id: string;
        supplier_name: string; total: string; currency_code: string;
        confirmation_status: 'PAID' | 'PENDING_PAYMENT'; confirmed_at: Date }>(
        `SELECT id, branch_id, actor_user_id, supplier_snapshot->>'name' AS supplier_name,
          total::text AS total, currency_code, confirmation_status, confirmed_at
         FROM purchases WHERE organization_id = $1 AND id = $2`,
        [context.organizationId, purchaseId]);
      const purchase = found.rows[0];
      if (!purchase) throw new NotFoundException({ code: 'PURCHASE_NOT_AVAILABLE',
        title: 'Compra no disponible', detail: 'No encontramos la compra solicitada.' });
      const access = await client.query<{ role: string; allowed: boolean }>(`SELECT m.role,
        (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope s
          WHERE s.organization_id = m.organization_id AND s.membership_id = m.id
            AND s.branch_id = $3)) AS allowed FROM memberships m
        WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE'
          AND m.revoked_at IS NULL`, [context.organizationId, context.userId, purchase.branch_id]);
      const actor = access.rows[0];
      if (!actor?.allowed || !['OWNER', 'ADMIN', 'EMPLOYEE'].includes(actor.role)
        || actor.role === 'EMPLOYEE' && purchase.actor_user_id !== context.userId) {
        throw new ForbiddenException({ code: 'PURCHASE_READ_FORBIDDEN',
          title: 'Compra no disponible', detail: 'No tenés acceso a esta compra.' });
      }
      const items = await client.query<{ itemName: string; quantity: string; unitCost: string;
        lineTotal: string }>(`SELECT item_name AS "itemName", quantity::text AS quantity,
          unit_cost::text AS "unitCost", line_total::text AS "lineTotal"
        FROM purchase_items WHERE organization_id = $1 AND purchase_id = $2 ORDER BY id`,
      [context.organizationId, purchaseId]);
      const payment = await client.query<{ method: string; amount: string }>(`SELECT method,
        amount::text AS amount FROM purchase_payments
        WHERE organization_id = $1 AND purchase_id = $2`, [context.organizationId, purchaseId]);
      const cancellation = await client.query<{ reason: string; cancelledAt: Date }>(`SELECT reason,
        cancelled_at AS "cancelledAt" FROM purchase_cancellations
        WHERE organization_id = $1 AND purchase_id = $2`, [context.organizationId, purchaseId]);
      const historical = cancellation.rows[0];
      const paid = payment.rows[0];
      return { id: purchase.id, branchId: purchase.branch_id,
        status: historical ? 'CANCELLED' as const : paid || purchase.confirmation_status === 'PAID'
          ? 'PAID' as const : 'PENDING_PAYMENT' as const,
        total: purchase.total, currency: purchase.currency_code, supplierName: purchase.supplier_name,
        confirmedAt: purchase.confirmed_at.toISOString(), items: items.rows,
        payment: paid ?? null,
        cancellation: historical ? { reason: historical.reason,
          cancelledAt: historical.cancelledAt.toISOString() } : null };
    });
  }

  async confirmPending(context: TenantTransactionContext, input: ConfirmPendingPurchaseInput,
    key: string): Promise<ConfirmPendingPurchaseResult> {
    return this.retry(() => this.transactions.runWithOptionalAudit(context, async (client) => {
      await this.policy.authorize(client, context, input.branchId, 'CONFIRM_PENDING');
      const idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId,
        authorizationClass: 'PURCHASE_CONFIRM_PENDING', branchId: input.branchId, key,
        organizationId: context.organizationId, payload: toJsonValue(input), scope: 'purchase.confirm.pending',
      }, async () => { await this.policy.authorize(client, context, input.branchId, 'CONFIRM_PENDING'); });
      if (acquired.kind === 'replay') return { result: this.decodeResult(acquired.response.body) };
      await this.policy.authorize(client, context, input.branchId, 'CONFIRM_PENDING');
      const persisted = await this.persistence.persistPending(client, context, { ...input,
        id: input.clientOperationId });
      await this.applyStock(client, context, persisted.id);
      const result: ConfirmPendingPurchaseResult = { id: persisted.id, status: 'PENDING_PAYMENT',
        total: persisted.total, currency: persisted.currency };
      await idempotency.complete(acquired.record.id, { statusCode: 201, body: toJsonValue(result) });
      return { result, auditEvent: { action: 'purchase.confirmed',
        after: { status: result.status, total: result.total }, afterAllowlist: ['status', 'total'],
        before: {}, beforeAllowlist: [], branchId: input.branchId,
        context: { supplierId: input.supplierId }, contextAllowlist: ['supplierId'],
        deviceId: null, entityId: result.id, entityType: 'purchase',
        operationId: input.clientOperationId } };
    }));
  }

  /** Internal preparation; exposing the paid HTTP command belongs to a later task. */
  async preparePaid(context: TenantTransactionContext, input: ConfirmPendingPurchaseInput,
    payment: PurchasePaymentInput | null,
    key: string): Promise<{ id: string; status: 'PAID'; total: string; currency: string }> {
    return this.retry(() => this.transactions.runWithOptionalAudit(context, async (client) => {
      await this.policy.authorize(client, context, input.branchId, 'CONFIRM_PAID');
      const idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId,
        authorizationClass: 'PURCHASE_CONFIRM_PAID', branchId: input.branchId, key,
        organizationId: context.organizationId, payload: toJsonValue({ input, payment }),
        scope: 'purchase.confirm.paid',
      }, async () => { await this.policy.authorize(client, context, input.branchId, 'CONFIRM_PAID'); });
      if (acquired.kind === 'replay') {
        const value = acquired.response.body;
        if (typeof value !== 'object' || value === null || Array.isArray(value)
          || typeof value.id !== 'string' || value.status !== 'PAID'
          || typeof value.total !== 'string' || typeof value.currency !== 'string') {
          throw new TypeError('Invalid persisted paid purchase');
        }
        return { result: { id: value.id, status: 'PAID' as const,
          total: value.total, currency: value.currency } };
      }
      await this.policy.authorize(client, context, input.branchId, 'CONFIRM_PAID');
      if (payment?.method === 'CASH') await this.requireCashSession(client, context, input.branchId, payment);
      const persisted = await this.persistence.persistPaid(client, context,
        { ...input, id: input.clientOperationId });
      await this.applyStock(client, context, persisted.id);
      if (persisted.total === '0.00') {
        if (payment !== null) throw new PurchasePaymentError();
      } else {
        if (!payment) throw new PurchasePaymentError();
        const amount = validatePositiveMoney(payment.amount);
        if (amount !== persisted.total) throw new PurchasePaymentError();
        const method = await client.query<{ enabled: boolean }>(`SELECT enabled FROM payment_method_settings
          WHERE organization_id = $1 AND method = $2 FOR SHARE`, [context.organizationId, payment.method]);
        if (!method.rows[0]?.enabled) throw new PurchasePaymentError();
        await client.query(`INSERT INTO purchase_payments (id, organization_id, purchase_id, method,
          amount, currency_code) VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), context.organizationId, persisted.id, payment.method, amount, persisted.currency]);
        if (payment.method === 'CASH') await this.recordCashOut(client, context,
          input.branchId, persisted.id, persisted.currency, amount, payment);
      }
      const result = { ...persisted, status: 'PAID' as const };
      await idempotency.complete(acquired.record.id, { statusCode: 201, body: toJsonValue(result) });
      return { result, auditEvent: { action: 'purchase.confirmed',
        after: { status: result.status, total: result.total }, afterAllowlist: ['status', 'total'],
        before: {}, beforeAllowlist: [], branchId: input.branchId,
        context: { supplierId: input.supplierId, method: payment?.method ?? null },
        contextAllowlist: ['supplierId', 'method'], deviceId: payment?.deviceId ?? null,
        entityId: result.id, entityType: 'purchase', operationId: input.clientOperationId } };
    }));
  }

  /** Internal preparation; the HTTP command is added with the completed payment flow. */
  async preparePendingPayment(context: TenantTransactionContext, purchaseId: string,
    payment: PurchasePaymentInput, key: string): Promise<{ id: string; status: 'PAID'; total: string; currency: string }> {
    return this.retry(() => this.transactions.runWithOptionalAudit(context, async (client) => {
      const found = await client.query<{ branch_id: string }>(`SELECT branch_id FROM purchases
        WHERE organization_id = $1 AND id = $2`, [context.organizationId, purchaseId]);
      const branchId = found.rows[0]?.branch_id;
      if (!branchId) throw new PurchasePaymentError();
      await this.policy.authorize(client, context, branchId, 'PAY');
      const idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId,
        authorizationClass: 'PURCHASE_PAY', branchId, key, organizationId: context.organizationId,
        payload: toJsonValue({ purchaseId, payment }), scope: 'purchase.pay',
      }, async () => { await this.policy.authorize(client, context, branchId, 'PAY'); });
      if (acquired.kind === 'replay') return { result: this.decodePaidResult(acquired.response.body) };
      await this.policy.authorize(client, context, branchId, 'PAY');
      if (payment.method === 'CASH') await this.requireCashSession(client, context, branchId, payment);
      const locked = await client.query<{ total: string; currency_code: string; confirmation_status: string;
        has_payment: boolean; has_cancellation: boolean }>(`SELECT p.total::text AS total, p.currency_code, p.confirmation_status,
          EXISTS (SELECT 1 FROM purchase_payments pp WHERE pp.organization_id = p.organization_id
            AND pp.purchase_id = p.id) AS has_payment,
          EXISTS (SELECT 1 FROM purchase_cancellations pc WHERE pc.organization_id = p.organization_id
            AND pc.purchase_id = p.id) AS has_cancellation
          FROM purchases p WHERE p.organization_id = $1 AND p.id = $2 FOR UPDATE OF p`,
        [context.organizationId, purchaseId]);
      const purchase = locked.rows[0];
      const amount = validatePositiveMoney(payment.amount);
      if (!purchase || purchase.confirmation_status !== 'PENDING_PAYMENT' || purchase.has_payment
        || purchase.has_cancellation
        || !amount || amount !== purchase.total) throw new PurchasePaymentError();
      const method = await client.query<{ enabled: boolean }>(`SELECT enabled FROM payment_method_settings
        WHERE organization_id = $1 AND method = $2 FOR SHARE`, [context.organizationId, payment.method]);
      if (!method.rows[0]?.enabled) throw new PurchasePaymentError();
      await client.query(`INSERT INTO purchase_payments (id, organization_id, purchase_id, method,
        amount, currency_code) VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), context.organizationId, purchaseId, payment.method, amount, purchase.currency_code]);
      if (payment.method === 'CASH') await this.recordCashOut(client, context,
        branchId, purchaseId, purchase.currency_code, amount, payment);
      const result = { id: purchaseId, status: 'PAID' as const, total: purchase.total,
        currency: purchase.currency_code };
      await idempotency.complete(acquired.record.id, { statusCode: 201, body: toJsonValue(result) });
      return { result, auditEvent: { action: 'purchase.paid', entityType: 'purchase',
        entityId: purchaseId, operationId: purchaseId, branchId, deviceId: payment.deviceId ?? null,
        before: { status: 'PENDING_PAYMENT' }, beforeAllowlist: ['status'],
        after: { status: 'PAID', amount }, afterAllowlist: ['status', 'amount'],
        context: { method: payment.method }, contextAllowlist: ['method'] } };
    }));
  }

  async cancel(context: TenantTransactionContext, purchaseId: string,
    input: PurchaseCancellationCashInput & { readonly reason: string }, key: string):
    Promise<{ id: string; purchaseId: string; status: 'CANCELLED' }> {
    return this.retry(() => this.transactions.runWithOptionalAudit(context, async (client) => {
      const found = await client.query<{ branch_id: string }>(`SELECT branch_id FROM purchases
        WHERE organization_id = $1 AND id = $2`, [context.organizationId, purchaseId]);
      const branchId = found.rows[0]?.branch_id;
      if (!branchId) throw new PurchaseCancellationError('PURCHASE_CANCELLATION_NOT_AVAILABLE',
        'La compra no está disponible.');
      await this.policy.authorize(client, context, branchId, 'CANCEL');
      const idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId,
        authorizationClass: 'PURCHASE_CANCEL', branchId, key,
        organizationId: context.organizationId, payload: toJsonValue({ purchaseId, ...input }),
        scope: 'purchase.cancel',
      }, async () => { await this.policy.authorize(client, context, branchId, 'CANCEL'); });
      if (acquired.kind === 'replay') {
        const value = acquired.response.body;
        if (typeof value !== 'object' || value === null || Array.isArray(value)
          || typeof value.id !== 'string' || value.purchaseId !== purchaseId
          || value.status !== 'CANCELLED') throw new TypeError('Invalid persisted cancellation');
        return { result: { id: value.id, purchaseId, status: 'CANCELLED' as const } };
      }
      const cash = await this.cancellations.requireCashReturnSession(client, context, purchaseId, input);
      const prepared = await this.cancellations.prepare(client, context, purchaseId, input.reason);
      await this.cancellations.record(client, context, prepared);
      await this.cancellations.reverseStock(client, context, prepared);
      await this.cancellations.reversePayment(client, context, prepared, cash);
      if (cash) await this.cancellations.recordCashReturn(client, context, prepared, cash);
      const result = { id: prepared.id, purchaseId, status: 'CANCELLED' as const };
      await idempotency.complete(acquired.record.id, { statusCode: 201, body: toJsonValue(result) });
      return { result, auditEvent: { action: 'purchase.cancelled', entityType: 'purchase',
        entityId: purchaseId, operationId: prepared.id, branchId: prepared.branchId,
        deviceId: cash?.deviceId ?? null,
        before: { status: prepared.previousStatus }, beforeAllowlist: ['status'],
        after: { status: 'CANCELLED' }, afterAllowlist: ['status'],
        context: { reason: prepared.reason }, contextAllowlist: ['reason'] } };
    }));
  }

  private async requireCashSession(client: PoolClient, context: TenantTransactionContext,
    branchId: string, payment: PurchasePaymentInput): Promise<void> {
    if (!payment.cashSessionId || !payment.deviceId) throw new PurchasePaymentError();
    const session = await this.sessions.requireOperational(client, context.organizationId,
      payment.cashSessionId, payment.deviceId);
    if (session.branchId !== branchId) throw new PurchasePaymentError();
  }

  private async recordCashOut(client: PoolClient, context: TenantTransactionContext,
    branchId: string, purchaseId: string, currency: string, amount: string,
    payment: PurchasePaymentInput): Promise<void> {
    if (!payment.cashSessionId || !payment.deviceId) throw new PurchasePaymentError();
    const available = await client.query<{ sufficient: boolean; currency_code: string }>(
      `SELECT expected_cash >= $3::numeric AS sufficient, currency_code FROM cash_sessions
       WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, payment.cashSessionId, amount]);
    if (available.rows[0]?.currency_code !== currency) throw new PurchasePaymentError();
    if (!available.rows[0]?.sufficient) throw new PurchaseCashBalanceError();
    await client.query(`INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id,
      actor_user_id, device_id, delta, currency_code, source_type, source_id, effect_kind)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PURCHASE', $9, 'OUT')`,
      [randomUUID(), context.organizationId, branchId, payment.cashSessionId, context.userId,
        payment.deviceId, `-${amount}`, currency, purchaseId]);
  }

  private decodePaidResult(value: unknown): { id: string; status: 'PAID'; total: string; currency: string } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || !('id' in value) || typeof value.id !== 'string'
      || !('status' in value) || value.status !== 'PAID'
      || !('total' in value) || typeof value.total !== 'string'
      || !('currency' in value) || typeof value.currency !== 'string') {
      throw new TypeError('Invalid persisted paid purchase');
    }
    return { id: value.id, status: 'PAID', total: value.total, currency: value.currency };
  }

  private async applyStock(client: PoolClient, context: TenantTransactionContext,
    purchaseId: string): Promise<void> {
    const lines = await client.query<{ id: string }>(`SELECT id FROM purchase_items
      WHERE organization_id = $1 AND purchase_id = $2 AND track_inventory
      ORDER BY item_id, id`, [context.organizationId, purchaseId]);
    for (const line of lines.rows) {
      await client.query('SELECT inventory_api.apply_purchase_stock($1, $2, $3, $4)',
        [context.organizationId, purchaseId, line.id, context.userId]);
    }
  }

  private decodeResult(value: unknown): ConfirmPendingPurchaseResult {
    if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string'
      || !('total' in value) || typeof value.total !== 'string' || !('currency' in value)
      || typeof value.currency !== 'string' || !('status' in value)
      || value.status !== 'PENDING_PAYMENT') throw new TypeError('Invalid persisted purchase confirmation');
    return { id: value.id, status: value.status, total: value.total, currency: value.currency };
  }

  private async retry<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        const code = error instanceof Object && 'code' in error ? error.code : undefined;
        if (code !== '40P01' && code !== '40001') throw error;
        if (attempt === 3) throw new ConcurrentPurchaseModificationError();
        await new Promise<void>((resolve) => setTimeout(resolve, 5 * attempt));
      }
    }
    throw new ConcurrentPurchaseModificationError();
  }
}
