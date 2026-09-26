import { z } from 'zod';

import { ApiClient } from '../../lib/api/client';

const client = new ApiClient();
export const stockSchema = z.object({ branchId: z.string(), itemId: z.string(), itemName: z.string(),
  baseUnit: z.enum(['UNIT', 'FRACTIONAL']), quantity: z.string(), threshold: z.string().nullable(), lowStock: z.boolean() });
export type StockItem = z.infer<typeof stockSchema>;
const stockPageSchema = z.object({ stocks: z.array(stockSchema), nextCursor: z.string().nullable() });
export type StockPage = z.infer<typeof stockPageSchema>;
const adjustmentSchema = z.object({ id: z.string(), branchId: z.string(), itemId: z.string(),
  itemName: z.string(), direction: z.enum(['INCREASE', 'DECREASE']), quantity: z.string(),
  reason: z.string(), observation: z.string().nullable(), occurredAt: z.string(),
  compensatedBy: z.string().nullable(), compensates: z.string().nullable() });
const adjustmentPageSchema = z.object({ adjustments: z.array(adjustmentSchema), nextCursor: z.string().nullable() });
export type Adjustment = z.infer<typeof adjustmentSchema>;
export type AdjustmentPage = z.infer<typeof adjustmentPageSchema>;
const transferSchema = z.object({ id: z.string(), originBranchId: z.string(), destinationBranchId: z.string(),
  occurredAt: z.string(), compensatedBy: z.string().nullable(), compensates: z.string().nullable(),
  lines: z.array(z.object({ itemId: z.string(), itemName: z.string(), quantity: z.string() })) });
const transferPageSchema = z.object({ transfers: z.array(transferSchema), nextCursor: z.string().nullable() });
export type Transfer = z.infer<typeof transferSchema>;
export type TransferPage = z.infer<typeof transferPageSchema>;

export async function inventoryCsrf(): Promise<string> {
  const result = await client.request('/auth/csrf', { method: 'GET',
    parse: (value) => z.object({ csrfToken: z.string() }).parse(value) });
  if (!result) throw new Error('CSRF unavailable');
  return result.csrfToken;
}

export async function loadStocks(organizationId: string, branchId: string, after?: string): Promise<StockPage> {
  const path = `/inventory/stocks?branchId=${encodeURIComponent(branchId)}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
  const result = await client.request(path, { method: 'GET', organizationId,
    parse: (value) => stockPageSchema.parse(value) });
  if (!result) throw new Error('Empty stock response');
  return result;
}

export async function saveStockThreshold(organizationId: string, branchId: string,
  itemId: string, minimum: string | null): Promise<void> {
  await client.request(`/inventory/stocks/${encodeURIComponent(branchId)}/${encodeURIComponent(itemId)}/threshold`, {
    method: 'PUT', organizationId, csrfToken: await inventoryCsrf(), idempotencyKey: crypto.randomUUID(),
    body: { minimum }, parse: (value) => stockSchema.omit({ itemName: true, baseUnit: true }).parse(value),
  });
}

export async function loadAdjustments(organizationId: string, branchId: string, after?: string): Promise<AdjustmentPage> {
  const result = await client.request(`/inventory/adjustments?branchId=${encodeURIComponent(branchId)}${after ? `&after=${encodeURIComponent(after)}` : ''}`,
    { method: 'GET', organizationId, parse: (value) => adjustmentPageSchema.parse(value) });
  if (!result) throw new Error('Empty adjustment response');
  return result;
}

export async function confirmAdjustment(organizationId: string, input: {
  branchId: string; itemId: string; direction: 'INCREASE' | 'DECREASE'; quantity: string;
  reason: string; observation: string | null;
}): Promise<void> {
  await client.request('/inventory/adjustments', { method: 'POST', organizationId,
    csrfToken: await inventoryCsrf(), idempotencyKey: crypto.randomUUID(), body: input,
    parse: (value) => z.object({ id: z.string() }).parse(value) });
}

export async function compensateAdjustment(organizationId: string, id: string, observation: string | null): Promise<void> {
  await client.request(`/inventory/adjustments/${encodeURIComponent(id)}/compensations`, { method: 'POST', organizationId,
    csrfToken: await inventoryCsrf(), idempotencyKey: crypto.randomUUID(), body: { observation },
    parse: (value) => z.object({ id: z.string() }).parse(value) });
}

export async function loadTransfers(organizationId: string, branchId: string, after?: string): Promise<TransferPage> {
  const result = await client.request(`/inventory/transfers?branchId=${encodeURIComponent(branchId)}${after ? `&after=${encodeURIComponent(after)}` : ''}`,
    { method: 'GET', organizationId, parse: (value) => transferPageSchema.parse(value) });
  if (!result) throw new Error('Empty transfer response');
  return result;
}

export async function confirmTransfer(organizationId: string, input: {
  originBranchId: string; destinationBranchId: string; lines: { itemId: string; quantity: string }[];
}): Promise<void> {
  await client.request('/inventory/transfers', { method: 'POST', organizationId,
    csrfToken: await inventoryCsrf(), idempotencyKey: crypto.randomUUID(), body: input,
    parse: (value) => z.object({ id: z.string() }).parse(value) });
}

export async function compensateTransfer(organizationId: string, id: string): Promise<void> {
  await client.request(`/inventory/transfers/${encodeURIComponent(id)}/compensations`, { method: 'POST', organizationId,
    csrfToken: await inventoryCsrf(), idempotencyKey: crypto.randomUUID(), body: {},
    parse: (value) => z.object({ id: z.string() }).parse(value) });
}

export { client as inventoryClient };
