import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { z } from 'zod';

import { IdempotencyService, toJsonValue } from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { ExpensePersistence, type ExpenseInput, type ExpenseResult } from './expense-persistence.js';
import { ExpensePolicy } from './expense-policy.js';

const resultSchema = z.object({ id: z.uuid(), branchId: z.uuid(), categoryId: z.uuid(),
  concept: z.string(), amount: z.string(), method: z.string(), currency: z.string(),
  actorUserId: z.uuid(), occurredAt: z.string() });

export class ExpenseCashBalanceError extends Error {
  readonly code = 'CASH_INSUFFICIENT_EXPECTED' as const;
  constructor() { super('El efectivo esperado es insuficiente. Registrá un ingreso o usá otra sesión válida.'); }
}

export class ExpenseOperationsService {
  private readonly policy = new ExpensePolicy();
  private readonly persistence = new ExpensePersistence();
  constructor(private readonly transactions: TenantTransaction) {}

  async create(context: TenantTransactionContext, input: ExpenseInput, key: string): Promise<ExpenseResult> {
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new RangeError('Clave de idempotencia inválida.');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.transactions.runWithOptionalAudit(context, async (client) => {
          const role = await this.policy.authorize(client, context, input);
          const idempotency = new IdempotencyService(client);
          const acquired = await idempotency.acquire({ actorUserId: context.userId,
            authorizationClass: `EXPENSE_${role}`, branchId: input.branchId, key,
            organizationId: context.organizationId, payload: toJsonValue(input), scope: 'expense.create',
          }, async () => { await this.policy.authorize(client, context, input); });
          if (acquired.kind === 'replay') return { result: resultSchema.parse(acquired.response.body) };
          // Authorization and cash state are checked again after acquiring the idempotency row.
          await this.policy.authorize(client, context, input);
          const result = await this.persistence.persist(client, context, { ...input, id: randomUUID() });
          if (input.method === 'CASH') await this.recordCashOut(client, context, result, input);
          await idempotency.complete(acquired.record.id, { statusCode: 201, body: toJsonValue(result) });
          return { result, auditEvent: { action: 'expense.created', entityType: 'expense',
            entityId: result.id, operationId: result.id, branchId: result.branchId,
            deviceId: input.deviceId ?? null, before: {}, beforeAllowlist: [],
            after: { amount: result.amount, method: result.method }, afterAllowlist: ['amount', 'method'],
            context: { categoryId: result.categoryId }, contextAllowlist: ['categoryId'] } };
        });
      } catch (error) {
        const code = error instanceof Object && 'code' in error ? error.code : undefined;
        if (code !== '40P01' && code !== '40001' || attempt === 3) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 5 * attempt));
      }
    }
    throw new Error('Expense retry exhausted');
  }

  private async recordCashOut(client: PoolClient, context: TenantTransactionContext,
    result: ExpenseResult, input: ExpenseInput): Promise<void> {
    if (!input.cashSessionId || !input.deviceId) throw new TypeError('Cash session required');
    const available = await client.query<{ sufficient: boolean; currency_code: string }>(
      `SELECT expected_cash >= $3::numeric AS sufficient, currency_code FROM cash_sessions
       WHERE organization_id = $1 AND id = $2`, [context.organizationId, input.cashSessionId, result.amount]);
    if (available.rows[0]?.currency_code !== result.currency) throw new ExpenseCashBalanceError();
    if (!available.rows[0]?.sufficient) throw new ExpenseCashBalanceError();
    await client.query(`INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id,
      actor_user_id, device_id, delta, currency_code, source_type, source_id, effect_kind)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'EXPENSE', $9, 'OUT')`,
    [randomUUID(), context.organizationId, result.branchId, input.cashSessionId,
      context.userId, input.deviceId, `-${result.amount}`, result.currency, result.id]);
  }
}
