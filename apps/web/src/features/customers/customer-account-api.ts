import { z } from 'zod';
import { ApiClient } from '../../lib/api/client';
import { formatMoney } from '../../lib/format';

const client = new ApiClient();
const money = z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/);
const accountSummarySchema = z.object({ balance: money, creditLimit: money, available: money,
  currency: z.string(), version: z.number().int().positive() });
const entrySchema = z.object({ id: z.uuid(), branchId: z.uuid(), kind: z.enum(['SALE','COLLECTION','SALE_CANCELLATION','COLLECTION_REVERSAL']),
  amount: money, delta: z.string(), currency: z.string(), method: z.string().nullable(), saleId: z.uuid().nullable(),
  originalEntryId: z.uuid().nullable(), reason: z.string().nullable(), occurredAt: z.string(), reversed: z.boolean() });
const accountSchema = accountSummarySchema.extend({ entries: z.array(entrySchema), nextCursor: z.string().nullable() });
export type CustomerAccount = z.infer<typeof accountSchema>;
export const accountAmountInput = z.string().trim().regex(/^(?:0|[1-9]\d{0,17})(?:[.,]\d{1,2})?$/, 'Ingresá un importe válido de hasta dos decimales.');
export function canonicalAccountAmount(value: string) {
  const [whole = '0', fraction = ''] = accountAmountInput.parse(value).replace(',', '.').split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
export function formatAccountAmount(value: string, currency: string) {
  return formatMoney(value, currency);
}
async function csrf() {
  const value = await client.request('/auth/csrf', { method: 'GET', parse: raw => z.object({ csrfToken: z.string() }).parse(raw) });
  if (!value) throw new Error('CSRF unavailable'); return value.csrfToken;
}
export async function loadCustomerAccount(organizationId: string, customerId: string, branchId?: string, cursor?: string): Promise<CustomerAccount> {
  const query = new URLSearchParams({ limit: '25' }); if (branchId) query.set('branchId', branchId); if (cursor) query.set('cursor', cursor);
  const value = await client.request(`/customers/${encodeURIComponent(customerId)}/account?${query}`, {
    method: 'GET', organizationId, parse: raw => accountSchema.parse(raw) });
  if (!value) throw new Error('Account unavailable'); return value;
}
export async function setCustomerCreditLimit(organizationId: string, customerId: string, version: number, creditLimit: string, key: string) {
  return client.request(`/customers/${encodeURIComponent(customerId)}/account/limit`, { method: 'PATCH', organizationId,
    csrfToken: await csrf(), ifMatch: String(version), idempotencyKey: key, body: { creditLimit }, parse: raw => accountSummarySchema.parse(raw) });
}
const operationSchema = z.object({ id: z.uuid(), balance: money, currency: z.string() });
export async function collectCustomerDebt(organizationId: string, customerId: string,
  input: { cashSessionId: string; deviceId: string; amount: string; method: string }, key: string) {
  return client.request(`/customers/${encodeURIComponent(customerId)}/account/collections`, { method: 'POST', organizationId,
    csrfToken: await csrf(), idempotencyKey: key, body: input, parse: raw => operationSchema.parse(raw) });
}
export async function reverseCustomerCollection(organizationId: string, customerId: string, entryId: string,
  input: { cashSessionId: string; deviceId: string; reason: string }, key: string) {
  return client.request(`/customers/${encodeURIComponent(customerId)}/account/collections/${encodeURIComponent(entryId)}/reverse`, {
    method: 'POST', organizationId, csrfToken: await csrf(), idempotencyKey: key, body: input, parse: raw => operationSchema.parse(raw) });
}
