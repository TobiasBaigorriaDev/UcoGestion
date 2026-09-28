import type { PoolClient } from 'pg';

import { calculatePercentageDiscount, calculateSaleLine, Quantity, subtractMoney, sumMoney,
  validateFixedDiscount, validatePercentageDiscount, type QuantityUnit } from '@uconext/shared';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export type SalesQuoteErrorCode = 'SALE_BRANCH_NOT_FOUND' | 'SALE_ITEM_NOT_AVAILABLE' | 'SALE_QUANTITY_INVALID'
  | 'SALE_DISCOUNT_INVALID' | 'SALE_DISCOUNT_FORBIDDEN' | 'SALE_AMOUNT_OUT_OF_RANGE';

export class SalesQuoteError extends Error {
  constructor(readonly code: SalesQuoteErrorCode, message: string) { super(message); this.name = 'SalesQuoteError'; }
}

export interface SalesQuoteLineInput { readonly itemId: string; readonly quantity: string }
export interface SalesDiscountInput { readonly kind: 'PERCENTAGE' | 'FIXED'; readonly value: string }
export interface SalesQuoteLine {
  readonly itemId: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly priceVersion: number;
  readonly lineTotal: string;
}
export interface SalesQuote {
  readonly currency: string;
  readonly lines: readonly SalesQuoteLine[];
  readonly subtotal: string;
  readonly discount: string;
  readonly total: string;
}

interface CatalogQuoteRow {
  id: string;
  base_unit: QuantityUnit;
  price: string | null;
  price_version: string;
  status: string;
}

export class SalesQuoteService {
  constructor(private readonly transactions: TenantTransaction) {}

  async quote(context: TenantTransactionContext, branchId: string, lines: readonly SalesQuoteLineInput[],
    discount?: SalesDiscountInput): Promise<SalesQuote> {
    return this.transactions.read(context, (client) => this.quoteInTransaction(client, context.organizationId, branchId,
      lines, discount, context.userId));
  }

  async quoteInTransaction(client: PoolClient, organizationId: string, branchId: string,
    lines: readonly SalesQuoteLineInput[], discount?: SalesDiscountInput, userId?: string,
    lockPrices = false): Promise<SalesQuote> {
    if (lines.length === 0) throw new SalesQuoteError('SALE_ITEM_NOT_AVAILABLE', 'La venta necesita al menos un ítem.');
    const branch = await client.query<{ currency: string }>(
      `SELECT o.base_currency AS currency FROM branches b JOIN organizations o ON o.id = b.organization_id
       WHERE b.organization_id = $1 AND b.id = $2 AND b.status = 'ACTIVE'`, [organizationId, branchId]);
    const currency = branch.rows[0]?.currency;
    if (!currency) throw new SalesQuoteError('SALE_BRANCH_NOT_FOUND', 'La sucursal no está disponible.');
    const ids = [...new Set(lines.map((line) => line.itemId))].sort();
    const result = await client.query<CatalogQuoteRow>(
      `SELECT id, base_unit, price::text, price_version::text, status FROM catalog_items
       WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id ${lockPrices ? 'FOR SHARE' : ''}`,
      [organizationId, ids]);
    const items = new Map(result.rows.map((row) => [row.id, row]));
    const quotedLines = lines.map((line): SalesQuoteLine => {
      const item = items.get(line.itemId);
      if (!item || item.status !== 'ACTIVE' || item.price === null || Number(item.price_version) < 1) {
        throw new SalesQuoteError('SALE_ITEM_NOT_AVAILABLE', 'El ítem no está disponible para venta.');
      }
      let quantity: string;
      try { quantity = Quantity.from(line.quantity, item.base_unit).toString(); }
      catch { throw new SalesQuoteError('SALE_QUANTITY_INVALID', 'La cantidad no es válida para la unidad.'); }
      if (!/^(?:0|[1-9]\d{0,16})(?:\.\d{1,3})?$/.test(quantity)) {
        throw new SalesQuoteError('SALE_QUANTITY_INVALID', 'La cantidad supera la precisión admitida.');
      }
      const lineTotal = calculateSaleLine(quantity, item.price);
      if (!/^(?:0|[1-9]\d{0,17})\.\d{2}$/.test(lineTotal)) {
        throw new SalesQuoteError('SALE_AMOUNT_OUT_OF_RANGE', 'El importe supera la precisión admitida.');
      }
      return { itemId: item.id, quantity, unitPrice: item.price, priceVersion: Number(item.price_version),
        lineTotal };
    });
    const subtotal = sumMoney(quotedLines.map((line) => line.lineTotal));
    if (!/^(?:0|[1-9]\d{0,17})\.\d{2}$/.test(subtotal)) {
      throw new SalesQuoteError('SALE_AMOUNT_OUT_OF_RANGE', 'El subtotal supera la precisión admitida.');
    }
    let discountAmount = '0.00';
    if (discount !== undefined) {
      const membership = await client.query<{ role: string }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2
         AND status = 'ACTIVE' AND revoked_at IS NULL`, [organizationId, userId]);
      if (!['OWNER', 'ADMIN'].includes(membership.rows[0]?.role ?? '')) {
        throw new SalesQuoteError('SALE_DISCOUNT_FORBIDDEN', 'Solo OWNER o ADMIN pueden aplicar descuentos.');
      }
      if (discount.kind === 'PERCENTAGE' && validatePercentageDiscount(discount.value) !== undefined) {
        discountAmount = calculatePercentageDiscount(subtotal, discount.value);
      } else if (discount.kind === 'FIXED' && validateFixedDiscount(discount.value, subtotal) !== undefined) {
        discountAmount = sumMoney([discount.value]);
      } else {
        throw new SalesQuoteError('SALE_DISCOUNT_INVALID', 'El descuento no es válido.');
      }
    }
    return { currency, lines: quotedLines, subtotal, discount: discountAmount,
      total: subtractMoney(subtotal, discountAmount) };
  }
}
