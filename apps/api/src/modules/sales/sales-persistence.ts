import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { arePaymentsValidForSale, subtractMoney, sumMoney, validatePositiveMoney } from '@uconext/shared';

import { AuditEventWriter } from '../../core/audit/audit-event-writer.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDevicePolicy } from '../cash/index.js';
import type { SalesQuote } from './sales-quote.service.js';

export interface ConfirmedSaleInput {
  readonly id: string;
  readonly branchId: string;
  readonly cashSessionId: string;
  readonly deviceId: string;
  readonly clientOperationId: string;
  readonly customerId: string | null;
  readonly quote: SalesQuote;
  readonly payments: readonly SalePaymentInput[];
}

export interface SalePaymentInput {
  readonly method: string;
  readonly appliedAmount: string;
  readonly receivedAmount?: string | undefined;
}

export class SalePaymentError extends Error {
  constructor(readonly code: 'SALE_PAYMENTS_INVALID' | 'SALE_PAYMENT_METHOD_DISABLED', message: string) {
    super(message); this.name = 'SalePaymentError';
  }
}

export class SaleCustomerError extends Error {
  readonly code = 'SALE_CUSTOMER_NOT_AVAILABLE' as const;
  constructor() { super('El cliente no está disponible para una nueva venta.'); this.name = 'SaleCustomerError'; }
}

export class SaleSessionBranchError extends Error {
  readonly code = 'SALE_SESSION_BRANCH_CONFLICT' as const;
  constructor() { super('La sesión pertenece a otra sucursal.'); this.name = 'SaleSessionBranchError'; }
}

export class SaleStockError extends Error {
  readonly code = 'SALE_STOCK_INSUFFICIENT' as const;
  constructor() { super('No hay stock suficiente para confirmar la venta.'); this.name = 'SaleStockError'; }
}

export class SalesPersistence {
  async persist(client: PoolClient, context: TenantTransactionContext, input: ConfirmedSaleInput): Promise<{ id: string }> {
    const session = await new CashSessionDevicePolicy().requireAuthorizedActor(client, context,
      input.cashSessionId, input.deviceId);
    if (session.branchId !== input.branchId) throw new SaleSessionBranchError();
    const organization = await client.query<{ name: string; profile: unknown; currency: string; branch_name: string }>(
      `SELECT o.name, o.profile, o.base_currency AS currency, b.name AS branch_name
       FROM organizations o JOIN branches b ON b.organization_id = o.id
       WHERE o.id = $1 AND b.id = $2`, [context.organizationId, input.branchId]);
    const snapshot = organization.rows[0];
    if (!snapshot || snapshot.currency !== input.quote.currency) throw new Error('Invalid sale organization or currency');

    const customer = input.customerId === null ? null : (await client.query<{
      name: string; tax_id: string | null; contact: string | null; address: string | null;
    }>(`SELECT name, tax_id, contact, address FROM customers
      WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'`, [context.organizationId, input.customerId])).rows[0];
    if (input.customerId !== null && !customer) throw new SaleCustomerError();

    if (!arePaymentsValidForSale(input.quote.total, input.payments.map((payment) => payment.appliedAmount))) {
      throw new SalePaymentError('SALE_PAYMENTS_INVALID', 'Los pagos deben cubrir exactamente el total.');
    }
    const paymentMethods = [...new Set(input.payments.map((payment) => payment.method))].sort();
    for (const method of paymentMethods) {
      const setting = await client.query<{ enabled: boolean }>(
        `SELECT enabled FROM payment_method_settings WHERE organization_id = $1 AND method = $2 FOR SHARE`,
        [context.organizationId, method]);
      if (!setting.rows[0]?.enabled) {
        throw new SalePaymentError('SALE_PAYMENT_METHOD_DISABLED', 'El medio de pago no está habilitado.');
      }
    }
    const preparedPayments = input.payments.map((payment) => {
      if (payment.method !== 'CASH') {
        if (payment.receivedAmount !== undefined) {
          throw new SalePaymentError('SALE_PAYMENTS_INVALID', 'Solo el efectivo admite importe recibido.');
        }
        return { ...payment, receivedAmount: null, changeAmount: '0.00' };
      }
      const receivedAmount = payment.receivedAmount ?? payment.appliedAmount;
      if (validatePositiveMoney(receivedAmount) === undefined) {
        throw new SalePaymentError('SALE_PAYMENTS_INVALID', 'El efectivo recibido no es válido.');
      }
      const changeAmount = subtractMoney(receivedAmount, payment.appliedAmount);
      if (changeAmount.startsWith('-')) {
        throw new SalePaymentError('SALE_PAYMENTS_INVALID', 'El efectivo recibido es insuficiente.');
      }
      return { ...payment, receivedAmount, changeAmount };
    });

    const itemIds = [...new Set(input.quote.lines.map((line) => line.itemId))].sort();
    const catalog = await client.query<{ id: string; name: string; type: string; sku: string | null;
      barcode: string | null; base_unit: string; track_inventory: boolean }>(
      `SELECT id, name, type, sku, barcode, base_unit, track_inventory FROM catalog_items
       WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR SHARE`,
      [context.organizationId, itemIds]);
    const items = new Map(catalog.rows.map((row) => [row.id, row]));
    if (items.size !== itemIds.length) throw new Error('Sale item unavailable');
    for (const itemId of itemIds) {
      if (!items.get(itemId)?.track_inventory) continue;
      const stock = await client.query<{ enough: boolean }>(
        `SELECT inventory_api.lock_sale_stock($1, $2, $3, $4,
          (SELECT SUM(value::numeric) FROM unnest($5::text[]) AS value)) AS enough`,
        [context.organizationId, input.branchId, itemId, context.userId,
          input.quote.lines.filter((line) => line.itemId === itemId).map((line) => line.quantity)]);
      if (!stock.rows[0]?.enough) throw new SaleStockError();
    }

    const receiptSnapshot = { label: 'Comprobante no fiscal',
      organization: { name: snapshot.name, profile: snapshot.profile },
      branch: { name: snapshot.branch_name }, customer: customer ?? null,
      currency: input.quote.currency, subtotal: input.quote.subtotal, discount: input.quote.discount,
      total: input.quote.total,
      items: input.quote.lines.map((line) => ({ ...line, name: items.get(line.itemId)?.name,
        unit: items.get(line.itemId)?.base_unit })),
      payments: preparedPayments };
    await client.query(`INSERT INTO sales (id, organization_id, branch_id, cash_session_id, device_id, customer_id,
      actor_user_id, session_owner_user_id, client_operation_id, currency_code, subtotal, discount, total, receipt_snapshot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
    [input.id, context.organizationId, input.branchId, input.cashSessionId, input.deviceId,
      input.customerId, context.userId, session.ownerUserId, input.clientOperationId, input.quote.currency,
      input.quote.subtotal, input.quote.discount, input.quote.total, JSON.stringify(receiptSnapshot)]);
    await client.query(`INSERT INTO organization_history_references
      (id, organization_id, reference_domain, reference_type, source_id)
      VALUES ($1, $2, 'MONETARY', 'SALE', $3)`, [randomUUID(), context.organizationId, input.id]);

    for (const line of input.quote.lines) {
      const snapshotItem = items.get(line.itemId);
      if (!snapshotItem) throw new Error('Sale item unavailable');
      const saleItemId = randomUUID();
      await client.query(`INSERT INTO sale_items (id, organization_id, sale_id, item_id, item_name, item_type,
        sku, barcode, unit, quantity, unit_price, price_version, line_total, currency_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [saleItemId, context.organizationId, input.id, line.itemId, snapshotItem.name, snapshotItem.type,
        snapshotItem.sku, snapshotItem.barcode, snapshotItem.base_unit, line.quantity,
        line.unitPrice, line.priceVersion, line.lineTotal, input.quote.currency]);
      if (snapshotItem.track_inventory) {
        await client.query('SELECT inventory_api.apply_sale_stock($1, $2, $3, $4)',
          [context.organizationId, input.id, saleItemId, context.userId]);
      }
    }
    for (const payment of preparedPayments) {
      await client.query(`INSERT INTO sale_payments (id, organization_id, sale_id, method,
        applied_amount, received_amount, change_amount, currency_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), context.organizationId, input.id, payment.method, payment.appliedAmount,
        payment.receivedAmount, payment.changeAmount, input.quote.currency]);
    }
    const cashApplied = sumMoney(preparedPayments.filter((payment) => payment.method === 'CASH')
      .map((payment) => payment.appliedAmount));
    if (cashApplied !== '0.00') {
      await client.query(`INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id,
        actor_user_id, device_id, delta, currency_code, source_type, source_id, effect_kind)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SALE', $9, 'IN')`,
      [randomUUID(), context.organizationId, input.branchId, input.cashSessionId,
        context.userId, input.deviceId, cashApplied, input.quote.currency, input.id]);
    }
    await new AuditEventWriter(client).append({ action: 'sale.confirmed', actorUserId: context.userId,
      after: { total: input.quote.total }, afterAllowlist: ['total'], before: {}, beforeAllowlist: [],
      branchId: input.branchId, context: { ownerUserId: session.ownerUserId },
      contextAllowlist: ['ownerUserId'], deviceId: input.deviceId, entityId: input.id,
      entityType: 'sale', operationId: input.clientOperationId,
      organizationId: context.organizationId, requestId: context.requestId });
    return { id: input.id };
  }
}
