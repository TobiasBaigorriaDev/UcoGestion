import type { PoolClient } from 'pg';

import { AuditEventWriter } from '../../core/audit/audit-event-writer.js';
import { IdempotencyService, toJsonValue } from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDevicePolicy } from '../cash/index.js';
import { SaleCancellationError, SaleCancellationPreparation } from './sale-cancellation-preparation.js';
import { assertAcceptedSalePrice, fingerprintSaleQuote } from './sales-price-acceptance.js';
import { SaleSessionBranchError, SalesPersistence, type SalePaymentInput } from './sales-persistence.js';
import { SalesQuoteError, SalesQuoteService, type SalesDiscountInput,
  type SalesQuoteLineInput } from './sales-quote.service.js';

export interface SaleConfirmationInput {
  readonly branchId: string;
  readonly cashSessionId: string;
  readonly deviceId: string;
  readonly clientOperationId: string;
  readonly customerId?: string | null | undefined;
  readonly lines: readonly SalesQuoteLineInput[];
  readonly discount?: SalesDiscountInput | undefined;
  readonly payments: readonly SalePaymentInput[];
  readonly quoteFingerprint: string;
  readonly previousKey?: string | undefined;
  readonly acceptedPriceChange?: true | undefined;
}

export interface SaleConfirmationResult {
  readonly id: string;
  readonly total: string;
  readonly receipt: { readonly label: string; readonly [key: string]: unknown };
}

export class ConcurrentSaleModificationError extends Error {
  readonly code = 'SALE_CONCURRENT_MODIFICATION' as const;
  constructor() { super('La venta encontró una modificación concurrente. Intentá nuevamente.'); }
}

export class SaleCheckoutContextError extends Error {
  readonly code = 'SALE_CHECKOUT_FORBIDDEN' as const;
  constructor() { super('No tenés una sesión disponible para vender en esta sucursal.'); }
}

export class SalesOperationsService {
  private readonly quotes: SalesQuoteService;
  private readonly sessions = new CashSessionDevicePolicy();
  private readonly persistence = new SalesPersistence();
  private readonly cancellations = new SaleCancellationPreparation();

  constructor(private readonly transactions: TenantTransaction) {
    this.quotes = new SalesQuoteService(transactions);
  }

  async checkoutContext(context: TenantTransactionContext, branchId: string): Promise<{
    sessions: { id: string; deviceId: string; registerName: string }[];
    paymentMethods: string[];
  }> {
    return this.transactions.read(context, async (client) => {
      const membership = await client.query<{ id: string; role: string }>(`SELECT id, role FROM memberships
        WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE' AND revoked_at IS NULL`,
      [context.organizationId, context.userId]);
      const actor = membership.rows[0];
      if (!actor || !['OWNER', 'ADMIN', 'CASHIER'].includes(actor.role)) throw new SaleCheckoutContextError();
      if (actor.role !== 'OWNER') {
        const scoped = await client.query(`SELECT 1 FROM effective_membership_branch_scope
          WHERE organization_id = $1 AND membership_id = $2 AND branch_id = $3`,
        [context.organizationId, actor.id, branchId]);
        if (!scoped.rowCount) throw new SaleCheckoutContextError();
      }
      const sessions = await client.query<{ id: string; deviceId: string; registerName: string }>(`
        SELECT s.id, s.device_id AS "deviceId", r.name AS "registerName"
        FROM cash_sessions s JOIN devices d ON d.organization_id = s.organization_id AND d.id = s.device_id
          JOIN cash_registers r ON r.organization_id = s.organization_id AND r.id = s.cash_register_id
        WHERE s.organization_id = $1 AND s.branch_id = $2 AND s.status = 'OPEN'
          AND d.status = 'ACTIVE' AND ($3::text <> 'CASHIER' OR s.owner_user_id = $4)
        ORDER BY r.name, s.id`, [context.organizationId, branchId, actor.role, context.userId]);
      const methods = await client.query<{ method: string }>(`SELECT method FROM payment_method_settings
        WHERE organization_id = $1 AND enabled = true ORDER BY method`, [context.organizationId]);
      return { sessions: sessions.rows, paymentMethods: methods.rows.map((row) => row.method) };
    });
  }

  async quote(context: TenantTransactionContext, branchId: string,
    lines: readonly SalesQuoteLineInput[], discount?: SalesDiscountInput) {
    return this.transactions.read(context, async (client) => {
      const allowed = await client.query<{ allowed: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM memberships m WHERE m.organization_id = $1 AND m.user_id = $2
          AND m.status = 'ACTIVE' AND m.revoked_at IS NULL
          AND (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope s
            WHERE s.organization_id = m.organization_id AND s.membership_id = m.id AND s.branch_id = $3))
      ) AS allowed`, [context.organizationId, context.userId, branchId]);
      if (!allowed.rows[0]?.allowed) {
        throw new SalesQuoteError('SALE_BRANCH_NOT_FOUND', 'La sucursal no está disponible.');
      }
      const quote = await this.quotes.quoteInTransaction(client, context.organizationId, branchId,
        lines, discount, context.userId);
      return { quote, quoteFingerprint: fingerprintSaleQuote(quote) };
    });
  }

  async receipt(context: TenantTransactionContext, saleId: string): Promise<SaleConfirmationResult['receipt'] | null> {
    return this.transactions.read(context, async (client) => {
      const result = await client.query<{ receipt_snapshot: SaleConfirmationResult['receipt'] }>(
        `SELECT s.receipt_snapshot FROM sales s JOIN memberships m
           ON m.organization_id = s.organization_id AND m.user_id = $2
         WHERE s.organization_id = $1 AND s.id = $3
           AND m.status = 'ACTIVE' AND m.revoked_at IS NULL
           AND m.role IN ('OWNER', 'ADMIN', 'CASHIER')
           AND (m.role <> 'CASHIER' OR s.actor_user_id = $2)
           AND (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope scope
             WHERE scope.organization_id = m.organization_id AND scope.membership_id = m.id
               AND scope.branch_id = s.branch_id))`,
        [context.organizationId, context.userId, saleId]);
      return result.rows[0]?.receipt_snapshot ?? null;
    });
  }

  async detail(context: TenantTransactionContext, saleId: string): Promise<{
    id: string; branchId: string; status: 'CONFIRMED' | 'CANCELLED';
    total: string; currency: string; confirmedAt: string; canCancel: boolean;
    cancellation: { reason: string; cancelledAt: string } | null;
    items: { name: string; quantity: string; unitPrice: string; lineTotal: string }[];
    payments: { method: string; amount: string; change: string }[];
  } | null> {
    return this.transactions.read(context, async (client) => {
      const result = await client.query<{ id: string; branchId: string; total: string;
        currency: string; confirmedAt: string; role: string; reason: string | null;
        cancelledAt: string | null }>(`SELECT s.id, s.branch_id AS "branchId", s.total::text,
        s.currency_code AS currency, s.confirmed_at::text AS "confirmedAt", m.role,
        c.reason, c.cancelled_at::text AS "cancelledAt"
        FROM sales s JOIN memberships m ON m.organization_id = s.organization_id
          AND m.user_id = $2 AND m.status = 'ACTIVE' AND m.revoked_at IS NULL
        LEFT JOIN sale_cancellations c ON c.organization_id = s.organization_id AND c.sale_id = s.id
        WHERE s.organization_id = $1 AND s.id = $3
          AND m.role IN ('OWNER', 'ADMIN', 'CASHIER')
          AND (m.role <> 'CASHIER' OR s.actor_user_id = $2)
          AND (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope scope
            WHERE scope.organization_id = m.organization_id AND scope.membership_id = m.id
              AND scope.branch_id = s.branch_id))`,
      [context.organizationId, context.userId, saleId]);
      const sale = result.rows[0];
      if (!sale) return null;
      const items = await client.query<{ name: string; quantity: string; unitPrice: string;
        lineTotal: string }>(`SELECT item_name AS name, quantity::text, unit_price::text AS "unitPrice",
        line_total::text AS "lineTotal" FROM sale_items
        WHERE organization_id = $1 AND sale_id = $2 ORDER BY id`, [context.organizationId, saleId]);
      const payments = await client.query<{ method: string; amount: string; change: string }>(`
        SELECT method, applied_amount::text AS amount, change_amount::text AS change
        FROM sale_payments WHERE organization_id = $1 AND sale_id = $2 ORDER BY id`,
      [context.organizationId, saleId]);
      return { id: sale.id, branchId: sale.branchId, total: sale.total, currency: sale.currency,
        confirmedAt: sale.confirmedAt, status: sale.cancelledAt ? 'CANCELLED' : 'CONFIRMED',
        canCancel: ['OWNER', 'ADMIN'].includes(sale.role) && !sale.cancelledAt,
        cancellation: sale.cancelledAt && sale.reason
          ? { reason: sale.reason, cancelledAt: sale.cancelledAt } : null,
        items: items.rows, payments: payments.rows };
    });
  }

  async confirm(context: TenantTransactionContext, input: SaleConfirmationInput,
    key: string): Promise<SaleConfirmationResult> {
    return this.retry(() => this.transactions.runWithOptionalAudit(context, async (client) => {
      await this.authorize(client, context, input, true);
      const idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId,
        authorizationClass: 'SALE_CONFIRM', branchId: input.branchId, key,
        organizationId: context.organizationId, payload: toJsonValue(input), scope: 'sale.confirm',
      }, async () => this.authorize(client, context, input, true));
      if (acquired.kind === 'replay') {
        return { result: this.decodeResult(acquired.response.body) };
      }
      await this.authorize(client, context, input, false);
      const quote = await this.quotes.quoteInTransaction(client, context.organizationId, input.branchId,
        input.lines, input.discount, context.userId, true);
      assertAcceptedSalePrice(quote, { fingerprint: input.quoteFingerprint, idempotencyKey: key,
        ...(input.previousKey === undefined ? {} : { previousKey: input.previousKey }),
        ...(input.acceptedPriceChange === undefined ? {} : { acceptedPriceChange: true }) });
      await this.persistence.persist(client, context, { id: input.clientOperationId,
        branchId: input.branchId, cashSessionId: input.cashSessionId, deviceId: input.deviceId,
        clientOperationId: input.clientOperationId, customerId: input.customerId ?? null,
        quote, payments: input.payments });
      const snapshot = await client.query<{ receipt_snapshot: SaleConfirmationResult['receipt'] }>(
        'SELECT receipt_snapshot FROM sales WHERE organization_id = $1 AND id = $2',
        [context.organizationId, input.clientOperationId]);
      const receipt = snapshot.rows[0]?.receipt_snapshot;
      if (!receipt) throw new Error('Confirmed sale receipt missing');
      const result = { id: input.clientOperationId, total: quote.total, receipt };
      await idempotency.complete(acquired.record.id, { statusCode: 201, body: toJsonValue(result) });
      return { result };
    }));
  }

  async cancel(context: TenantTransactionContext, saleId: string,
    input: { readonly reason: string; readonly cashSessionId?: string | undefined;
      readonly deviceId?: string | undefined }, key: string): Promise<{
      id: string; saleId: string; status: 'CANCELLED' }> {
    return this.retry(() => this.transactions.runWithOptionalAudit(context, async (client) => {
      const branchId = await this.authorizeCancellation(client, context, saleId);
      const idempotency = new IdempotencyService(client);
      const acquired = await idempotency.acquire({ actorUserId: context.userId,
        authorizationClass: 'SALE_CANCEL', branchId, key, organizationId: context.organizationId,
        payload: toJsonValue({ saleId, ...input }), scope: 'sale.cancel',
      }, async () => { await this.authorizeCancellation(client, context, saleId); });
      if (acquired.kind === 'replay') {
        const value = acquired.response.body;
        if (typeof value !== 'object' || value === null || Array.isArray(value) ||
          typeof value.id !== 'string' || value.saleId !== saleId || value.status !== 'CANCELLED') {
          throw new TypeError('Invalid persisted sale cancellation');
        }
        return { result: { id: value.id, saleId, status: 'CANCELLED' as const } };
      }
      const cash = await this.cancellations.requireCashRefundSession(client, context,
        saleId, input.cashSessionId, input.deviceId);
      const cancellation = await this.cancellations.prepare(client, context, saleId, input.reason);
      await this.cancellations.record(client, context, cancellation);
      await this.cancellations.reverseStock(client, context, cancellation);
      await this.cancellations.refund(client, context, cancellation);
      if (cash) await this.cancellations.recordCashRefund(client, context, cancellation, cash);
      await new AuditEventWriter(client).append({ action: 'sale.cancelled',
        actorUserId: context.userId, after: { status: 'CANCELLED' }, afterAllowlist: ['status'],
        before: { status: 'CONFIRMED' }, beforeAllowlist: ['status'],
        branchId: cancellation.branchId, context: { reason: cancellation.reason },
        contextAllowlist: ['reason'], deviceId: input.deviceId ?? null,
        entityId: saleId, entityType: 'sale', operationId: cancellation.cancellationId,
        organizationId: context.organizationId, requestId: context.requestId });
      const result = { id: cancellation.cancellationId, saleId, status: 'CANCELLED' as const };
      await idempotency.complete(acquired.record.id, { statusCode: 201, body: toJsonValue(result) });
      return { result };
    }));
  }

  private async authorizeCancellation(client: PoolClient, context: TenantTransactionContext,
    saleId: string): Promise<string> {
    const result = await client.query<{ branch_id: string; allowed: boolean }>(`SELECT s.branch_id,
      EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = s.organization_id
        AND m.user_id = $2 AND m.status = 'ACTIVE' AND m.revoked_at IS NULL
        AND m.role IN ('OWNER', 'ADMIN') AND (m.role = 'OWNER' OR EXISTS
          (SELECT 1 FROM effective_membership_branch_scope scope
           WHERE scope.organization_id = m.organization_id AND scope.membership_id = m.id
             AND scope.branch_id = s.branch_id))) AS allowed
      FROM sales s WHERE s.organization_id = $1 AND s.id = $3`,
    [context.organizationId, context.userId, saleId]);
    const sale = result.rows[0];
    if (!sale) throw new SaleCancellationError('SALE_CANCELLATION_NOT_AVAILABLE',
      'La venta no está disponible.');
    if (!sale.allowed) throw new SaleCancellationError('SALE_CANCELLATION_FORBIDDEN',
      'No tenés permiso para anular esta venta.');
    return sale.branch_id;
  }

  private async retry<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        const code = error instanceof Object && 'code' in error ? error.code : undefined;
        if (code !== '40P01' && code !== '40001') throw error;
        if (attempt === 3) throw new ConcurrentSaleModificationError();
        await new Promise<void>((resolve) => setTimeout(resolve, 5 * attempt));
      }
    }
    throw new ConcurrentSaleModificationError();
  }

  private async authorize(client: PoolClient, context: TenantTransactionContext,
    input: SaleConfirmationInput, allowClosed: boolean): Promise<void> {
    const session = await this.sessions.requireAuthorizedActor(client, context,
      input.cashSessionId, input.deviceId, allowClosed);
    if (session.branchId !== input.branchId) throw new SaleSessionBranchError();
  }

  private decodeResult(value: unknown): SaleConfirmationResult {
    if (typeof value !== 'object' || value === null || !('id' in value) ||
      typeof value.id !== 'string' || !('total' in value) || typeof value.total !== 'string' ||
      !('receipt' in value) || typeof value.receipt !== 'object' || value.receipt === null ||
      !('label' in value.receipt) || typeof value.receipt.label !== 'string') {
      throw new TypeError('Invalid persisted sale confirmation');
    }
    return { id: value.id, total: value.total,
      receipt: value.receipt as SaleConfirmationResult['receipt'] };
  }
}
