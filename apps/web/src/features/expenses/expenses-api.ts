import { z } from 'zod';

import { ApiClient } from '../../lib/api/client';

const client = new ApiClient();
const expenseSchema = z.object({ id: z.string(), branchId: z.string(), categoryId: z.string(),
  concept: z.string(), amount: z.string(), method: z.string(), currency: z.string(),
  actorUserId: z.string(), occurredAt: z.string() });
const detailSchema = expenseSchema.extend({ status: z.enum(['CONFIRMED', 'CANCELLED']),
  cancellation: z.object({ reason: z.string(), cancelledAt: z.string() }).nullable() });
export type ExpenseDetail = z.infer<typeof detailSchema>;
export type ExpenseInput = { branchId: string; categoryId: string; concept: string;
  amount: string; method: string; cashSessionId?: string; deviceId?: string };

async function csrf(): Promise<string> {
  const value = await client.request('/auth/csrf', { method: 'GET',
    parse: (raw) => z.object({ csrfToken: z.string() }).parse(raw) });
  if (!value) throw new Error('CSRF unavailable');
  return value.csrfToken;
}

export async function createExpense(organizationId: string, input: ExpenseInput, key: string) {
  const value = await client.request('/expenses', { method: 'POST', organizationId,
    csrfToken: await csrf(), idempotencyKey: key, body: input,
    parse: (raw) => expenseSchema.parse(raw) });
  if (!value) throw new Error('Expense unavailable');
  return value;
}

export async function loadExpense(organizationId: string, id: string): Promise<ExpenseDetail> {
  const value = await client.request(`/expenses/${encodeURIComponent(id)}`, { method: 'GET', organizationId,
    parse: (raw) => detailSchema.parse(raw) });
  if (!value) throw new Error('Expense unavailable');
  return value;
}

export async function cancelExpense(organizationId: string, id: string,
  input: { reason: string; cashSessionId?: string; deviceId?: string }, key: string) {
  const value = await client.request(`/expenses/${encodeURIComponent(id)}/cancellations`,
    { method: 'POST', organizationId, csrfToken: await csrf(), idempotencyKey: key, body: input,
      parse: (raw) => z.object({ id: z.string(), expenseId: z.string(), status: z.literal('CANCELLED') }).parse(raw) });
  if (!value) throw new Error('Cancellation unavailable');
  return value;
}

export async function loadActiveExpenseCategories(organizationId: string) {
  const value = await client.request('/expense-categories/active', { method: 'GET', organizationId,
    parse: (raw) => z.object({ categories: z.array(z.object({ id: z.string(), name: z.string() })) }).parse(raw) });
  return value?.categories ?? [];
}
