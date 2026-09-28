import { z } from 'zod';

import { ApiClient } from '../../lib/api/client';

const client = new ApiClient();
const confirmationSchema = z.object({ id: z.string(), status: z.enum(['PAID', 'PENDING_PAYMENT']),
  total: z.string(), currency: z.string() });
export type PurchaseConfirmation = z.infer<typeof confirmationSchema>;
export interface PurchaseConfirmationInput { branchId: string; supplierId: string; clientOperationId: string;
  lines: readonly { itemId: string; quantity: string; unitCost: string }[] }
export interface PurchasePaymentInput { method: string; amount: string; cashSessionId?: string; deviceId?: string }

async function csrf(): Promise<string> {
  const value = await client.request('/auth/csrf', { method: 'GET',
    parse: (raw) => z.object({ csrfToken: z.string() }).parse(raw) });
  if (!value) throw new Error('CSRF unavailable');
  return value.csrfToken;
}

export async function confirmPurchase(organizationId: string, input: PurchaseConfirmationInput,
  status: 'PENDING_PAYMENT' | 'PAID', payment: PurchasePaymentInput | null,
  key: string): Promise<PurchaseConfirmation> {
  const path = status === 'PAID' ? '/purchases/paid' : '/purchases';
  const result = await client.request(path, { method: 'POST', organizationId,
    csrfToken: await csrf(), idempotencyKey: key,
    body: status === 'PAID' ? { ...input, payment } : input,
    parse: (raw) => confirmationSchema.parse(raw) });
  if (!result) throw new Error('Purchase response unavailable');
  return result;
}

const detailSchema = z.object({ id: z.string(), branchId: z.string(),
  status: z.enum(['PENDING_PAYMENT', 'PAID', 'CANCELLED']), total: z.string(), currency: z.string(),
  supplierName: z.string(), confirmedAt: z.string(),
  items: z.array(z.object({ itemName: z.string(), quantity: z.string(), unitCost: z.string(), lineTotal: z.string() })),
  payment: z.object({ method: z.string(), amount: z.string() }).nullable(),
  cancellation: z.object({ reason: z.string(), cancelledAt: z.string() }).nullable() });
export type PurchaseDetail = z.infer<typeof detailSchema>;

export async function loadPurchase(organizationId: string, id: string): Promise<PurchaseDetail> {
  const result = await client.request(`/purchases/${encodeURIComponent(id)}`, { method: 'GET', organizationId,
    parse: (raw) => detailSchema.parse(raw) });
  if (!result) throw new Error('Purchase unavailable');
  return result;
}

export async function payPurchase(organizationId: string, id: string,
  payment: PurchasePaymentInput, key: string): Promise<void> {
  await client.request(`/purchases/${encodeURIComponent(id)}/pay`, { method: 'POST', organizationId,
    csrfToken: await csrf(), idempotencyKey: key, body: payment,
    parse: (raw) => confirmationSchema.parse(raw) });
}

export async function cancelPurchase(organizationId: string, id: string,
  input: { reason: string; cashSessionId?: string; deviceId?: string }, key: string): Promise<void> {
  await client.request(`/purchases/${encodeURIComponent(id)}/cancel`, { method: 'POST', organizationId,
    csrfToken: await csrf(), idempotencyKey: key, body: input,
    parse: (raw) => z.object({ id: z.string(), purchaseId: z.string(), status: z.literal('CANCELLED') }).parse(raw) });
}
