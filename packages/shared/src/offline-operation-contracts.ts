import { z } from 'zod';
import type { OfflineGrantClaims } from './offline-contracts.js';

export const offlineSaleLinesSchema = z.array(z.strictObject({ itemId: z.uuid(),
  quantity: z.string().regex(/^(?:0|[1-9]\d{0,16})(?:\.\d{1,3})?$/) })).min(1).max(500);
const moneySchema = z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/);
export const offlineDiscountSchema = z.strictObject({ kind: z.enum(['FIXED', 'PERCENTAGE']), value: z.string().max(128) });
type DiscountAuthority = Pick<OfflineGrantClaims, 'role' | 'permissions' | 'actorUserId' | 'grantId' | 'configurationVersion'>;
export interface OfflineDiscountEvidence extends DiscountAuthority {
  readonly kind: 'FIXED' | 'PERCENTAGE'; readonly value: string; readonly amount: string;
}
export const offlineSaleDraftInputSchema = z.strictObject({ sessionId: z.uuid(), customerId: z.null().default(null),
  lines: offlineSaleLinesSchema, discount: offlineDiscountSchema.optional() });
export const offlineSaleDraftSchema = offlineSaleDraftInputSchema.extend({ id: z.uuid(),
  customerKind: z.literal('CONSUMER_FINAL'), configurationVersion: z.string().regex(/^[1-9]\d*$/), quote: z.unknown() });
const legacyQuoteLineSchema = z.strictObject({ itemId: z.uuid(), itemName: z.string(), sku: z.string().nullable(), barcode: z.string().nullable(),
  type: z.enum(['PRODUCT', 'SERVICE']), baseUnit: z.enum(['UNIT', 'FRACTIONAL']), trackInventory: z.boolean(),
  quantity: z.string().regex(/^(?:0|[1-9]\d{0,16})(?:\.\d{0,2}[1-9])?$/).refine(value => value !== '0'),
  unitPrice: moneySchema, priceVersion: z.number().int().positive(), lineTotal: moneySchema });
const legacyQuoteSchema = z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z.array(legacyQuoteLineSchema.refine(line => line.baseUnit !== 'UNIT' || !line.quantity.includes('.'))).min(1).max(500),
  subtotal: moneySchema, discount: moneySchema, total: moneySchema,
  discountEvidence: offlineDiscountSchema.extend({ actorUserId: z.uuid(), grantId: z.uuid(), configurationVersion: z.string(),
    role: z.enum(['OWNER', 'ADMIN']), permissions: z.strictObject({ canDiscount: z.literal(true) }), amount: moneySchema }).nullable(),
});
export const offlineSaleQuoteSchema = z.union([legacyQuoteSchema,
  legacyQuoteSchema.extend({ schemaVersion: z.literal(2),
    lines: z.array(legacyQuoteLineSchema.extend({ category: z.strictObject({ id: z.uuid(), name: z.string().min(1) }).nullable() })
      .refine(line => line.baseUnit !== 'UNIT' || !line.quantity.includes('.'))).min(1).max(500) })]);
export const offlinePaymentSchema = z.strictObject({ method: z.enum(['CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'TRANSFER', 'QR']),
  appliedAmount: moneySchema, receivedAmount: moneySchema.optional() });
export const offlineSaleConfirmSchema = z.strictObject({ draftId: z.uuid(), payments: z.array(offlinePaymentSchema).max(50) });
export const offlineSaleResultSchema = z.strictObject({ id: z.uuid(), operationId: z.uuid(), localReference: z.string(),
  total: moneySchema, change: moneySchema });
export const offlineConfirmedSaleSchema = z.strictObject({ id: z.uuid(), localReference: z.string(), reference: z.null(),
  status: z.literal('CONFIRMED'), requestHash: z.string().regex(/^[A-Za-z0-9+/]{43}=$/), actorUserId: z.uuid(), deviceId: z.uuid(), organizationId: z.uuid(),
  branchId: z.uuid(), cashSessionId: z.uuid(), customerId: z.null(), customerKind: z.literal('CONSUMER_FINAL'),
  configurationVersion: z.string(), quote: offlineSaleQuoteSchema,
  occurredAt: z.iso.datetime(), receivedAt: z.null(),
  payments: z.array(offlinePaymentSchema.omit({ receivedAmount: true }).extend({ receivedAmount: moneySchema.nullable(), changeAmount: moneySchema })).max(50),
  audit: z.strictObject({ action: z.literal('sale.confirmed.offline'), actorUserId: z.uuid(), grantId: z.uuid() }),
  receipt: z.strictObject({ label: z.literal('Comprobante no fiscal'), branchName: z.string() }),
  result: offlineSaleResultSchema,
});


