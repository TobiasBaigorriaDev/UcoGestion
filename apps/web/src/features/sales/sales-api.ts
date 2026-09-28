import { z } from 'zod';

import { ApiClient } from '../../lib/api/client';
import type { CartLine } from './pos-cart';
import type { PosPayment } from './pos-payment-rules';

const client = new ApiClient();
const quoteSchema = z.object({ currency: z.string(), subtotal: z.string(), discount: z.string(),
  total: z.string(), lines: z.array(z.object({ itemId: z.string(), quantity: z.string(),
    unitPrice: z.string(), priceVersion: z.number(), lineTotal: z.string() })) });
const quotedSchema = z.object({ quote: quoteSchema, quoteFingerprint: z.string() });
export type SaleQuote = z.infer<typeof quotedSchema>;
const contextSchema = z.object({ sessions: z.array(z.object({ id: z.string(), deviceId: z.string(),
  registerName: z.string() })), paymentMethods: z.array(z.string()) });
export type CheckoutContext = z.infer<typeof contextSchema>;
const confirmationSchema = z.object({ id: z.string(), total: z.string(), receipt: z.object({ label: z.string() }).passthrough() });
export type SaleConfirmation = z.infer<typeof confirmationSchema>;
const detailSchema = z.object({ id: z.string(), branchId: z.string(), status: z.enum(['CONFIRMED', 'CANCELLED']),
  total: z.string(), currency: z.string(), confirmedAt: z.string(), canCancel: z.boolean(),
  cancellation: z.object({ reason: z.string(), cancelledAt: z.string() }).nullable(),
  items: z.array(z.object({ name: z.string(), quantity: z.string(), unitPrice: z.string(), lineTotal: z.string() })),
  payments: z.array(z.object({ method: z.string(), amount: z.string(), change: z.string() })) });
export type SaleDetail = z.infer<typeof detailSchema>;

export type SaleDiscount = { kind: 'PERCENTAGE' | 'FIXED'; value: string };

async function csrf(): Promise<string> {
  const value = await client.request('/auth/csrf', { method: 'GET',
    parse: (raw) => z.object({ csrfToken: z.string() }).parse(raw) });
  if (!value) throw new Error('CSRF unavailable');
  return value.csrfToken;
}

export async function loadCheckoutContext(organizationId: string, branchId: string): Promise<CheckoutContext> {
  const value = await client.request(`/sales/checkout-context?branchId=${encodeURIComponent(branchId)}`,
    { method: 'GET', organizationId, parse: (raw) => contextSchema.parse(raw) });
  if (!value) throw new Error('Checkout context unavailable');
  return value;
}

export async function quoteSale(organizationId: string, branchId: string, lines: readonly CartLine[],
  discount?: SaleDiscount): Promise<SaleQuote> {
  const value = await client.request('/sales/quote', { method: 'POST', organizationId,
    csrfToken: await csrf(), body: { branchId, lines, ...(discount ? { discount } : {}) },
    parse: (raw) => quotedSchema.parse(raw) });
  if (!value) throw new Error('Sale quote unavailable');
  return value;
}

export async function confirmSale(organizationId: string, input: {
  branchId: string; cashSessionId: string; deviceId: string; clientOperationId: string;
  lines: readonly CartLine[]; discount?: SaleDiscount; payments: readonly PosPayment[];
  quoteFingerprint: string; previousKey?: string; acceptedPriceChange?: true;
}, key: string): Promise<SaleConfirmation> {
  const value = await client.request('/sales', { method: 'POST', organizationId,
    csrfToken: await csrf(), idempotencyKey: key, body: input,
    parse: (raw) => confirmationSchema.parse(raw) });
  if (!value) throw new Error('Sale confirmation unavailable');
  return value;
}

export async function loadSaleDetail(organizationId: string, id: string): Promise<SaleDetail> {
  const value = await client.request(`/sales/${encodeURIComponent(id)}`, { method: 'GET', organizationId,
    parse: (raw) => detailSchema.parse(raw) });
  if (!value) throw new Error('Sale not available');
  return value;
}

export async function cancelSale(organizationId: string, id: string, input: {
  reason: string; cashSessionId?: string; deviceId?: string;
}, key: string): Promise<void> {
  await client.request(`/sales/${encodeURIComponent(id)}/cancel`, { method: 'POST', organizationId,
    csrfToken: await csrf(), idempotencyKey: key, body: input,
    parse: (raw) => z.object({ id: z.string(), status: z.literal('CANCELLED') }).parse(raw) });
}
