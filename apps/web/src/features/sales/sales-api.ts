import { z } from 'zod';
import { saleCodeLookup } from '@uconext/shared';

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
const confirmationSchema = z.object({ id: z.uuid(), total: z.string(), receipt: z.object({ label: z.string() }).passthrough() });
export type SaleConfirmation = z.infer<typeof confirmationSchema>;
const detailSchema = z.object({ id: z.string(), branchId: z.string(), status: z.enum(['CONFIRMED', 'CANCELLED']),
  total: z.string(), currency: z.string(), confirmedAt: z.string(), canCancel: z.boolean(),
  cancellation: z.object({ reason: z.string(), cancelledAt: z.string() }).nullable(),
  items: z.array(z.object({ name: z.string(), quantity: z.string(), unitPrice: z.string(), lineTotal: z.string() })),
  payments: z.array(z.object({ method: z.string(), amount: z.string(), change: z.string() })) });
export type SaleDetail = z.infer<typeof detailSchema>;
const historySchema = z.object({ items: z.array(detailSchema.pick({ id: true, status: true,
  total: true, currency: true, confirmedAt: true }).extend({ branchId: z.string().optional() })),
  nextCursor: z.string().nullable() });
export type SaleHistoryFilters = { from?: string; to?: string; status?: 'CONFIRMED' | 'CANCELLED' };
const trendsSchema = z.object({ currency: z.string(), points: z.array(z.object({
  date: z.iso.date(), hour: z.number().int().min(0).max(23).optional(),
  amount: z.string(), count: z.number().int().nonnegative() })) });
export type SaleTrends = z.infer<typeof trendsSchema>;

export async function loadSaleTrends(organizationId: string, filters: {
  from: string; to: string; branchId?: string | undefined; groupBy?: 'DAY' | 'HOUR' | undefined;
}): Promise<SaleTrends> {
  const params = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.branchId) params.set('branchId', filters.branchId);
  if (filters.groupBy) params.set('groupBy', filters.groupBy);
  const result = await client.request(`/sales/trends?${params}`, { method: 'GET', organizationId,
    parse: raw => trendsSchema.parse(raw) });
  if (!result) throw new Error('Sale trends unavailable');
  return result;
}

export async function loadSaleHistory(organizationId: string, branchId: string | undefined,
  filters: SaleHistoryFilters & { cursor?: string | undefined }) {
  const query = new URLSearchParams({ limit: '25' });
  if (branchId) query.set('branchId', branchId);
  for (const [name, value] of Object.entries(filters)) if (value) query.set(name, value);
  const result = await client.request(`/sales?${query}`, { method: 'GET', organizationId,
    parse: (raw) => historySchema.parse(raw) });
  if (!result) throw new Error('Sale history unavailable');
  return { ...result, items: result.items.map(item => ({ ...item, branchId: item.branchId ?? branchId ?? '' })) };
}

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
  let resolvedId = id;
  if (!z.uuid().safeParse(id).success) {
    const code = saleCodeLookup(id);
    if (!code) throw new Error('Invalid sale code');
    const resolved = await client.request(`/sales/by-code/${encodeURIComponent(code.code)}`,
      { method: 'GET', organizationId, parse: raw => z.object({ id: z.uuid() }).parse(raw) });
    if (!resolved) throw new Error('Sale code unavailable');
    resolvedId = resolved.id;
  }
  const value = await client.request(`/sales/${encodeURIComponent(resolvedId)}`, { method: 'GET', organizationId,
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
