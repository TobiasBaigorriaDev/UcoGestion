import { randomUUID } from 'node:crypto';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { IdempotencyService, toJsonValue } from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { ExpenseCancellationError, ExpenseCancellationPreparation,
  type ExpenseCancellationCashInput } from './expense-cancellation-preparation.js';
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
  private readonly cancellations = new ExpenseCancellationPreparation();
  constructor(private readonly transactions: TenantTransaction) {}

  async detail(context: TenantTransactionContext, expenseId: string) {
    return this.transactions.read(context, async (client) => {
      const found = await client.query<{ id: string; branch_id: string; actor_user_id: string;
        category_id: string; concept: string; amount: string; method: string;
        currency_code: string; occurred_at: Date }>(`SELECT id, branch_id, actor_user_id,
        expense_category_id AS category_id, concept, amount::text AS amount, method,
        currency_code, occurred_at FROM expenses WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, expenseId]);
      const expense = found.rows[0];
      if (!expense) throw new NotFoundException({ code: 'EXPENSE_NOT_AVAILABLE',
        title: 'Gasto no disponible', detail: 'No encontramos el gasto solicitado.' });
      const membership = await client.query<{ role: string; allowed: boolean }>(`SELECT m.role,
        (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope s
          WHERE s.organization_id = m.organization_id AND s.membership_id = m.id
            AND s.branch_id = $3)) AS allowed FROM memberships m
        WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE'
          AND m.revoked_at IS NULL`, [context.organizationId, context.userId, expense.branch_id]);
      const actor = membership.rows[0];
      if (!actor?.allowed || !['OWNER', 'ADMIN', 'CASHIER'].includes(actor.role)
        || actor.role === 'CASHIER' && expense.actor_user_id !== context.userId) {
        throw new ForbiddenException({ code: 'EXPENSE_READ_FORBIDDEN',
          title: 'Gasto no disponible', detail: 'No tenés acceso a este gasto.' });
      }
      const cancellation = await client.query<{ reason: string; cancelledAt: Date }>(`SELECT reason,
        cancelled_at AS "cancelledAt" FROM expense_cancellations
        WHERE organization_id = $1 AND expense_id = $2`, [context.organizationId, expenseId]);
      const historical = cancellation.rows[0];
      return { id: expense.id, branchId: expense.branch_id, categoryId: expense.category_id,
        concept: expense.concept, amount: expense.amount, method: expense.method,
        currency: expense.currency_code, actorUserId: expense.actor_user_id,
        occurredAt: expense.occurred_at.toISOString(),
        status: historical ? 'CANCELLED' as const : 'CONFIRMED' as const,
        cancellation: historical ? { reason: historical.reason,
          cancelledAt: historical.cancelledAt.toISOString() } : null };
    });
  }

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

  async cancel(context: TenantTransactionContext, expenseId: string,
    input: ExpenseCancellationCashInput & { readonly reason: string }, key: string):
    Promise<{ id: string; expenseId: string; status: 'CANCELLED' }> {
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new RangeError('Clave de idempotencia inválida.');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.transactions.runWithOptionalAudit(context, async (client) => {
          const found = await client.query<{ branch_id: string }>(`SELECT branch_id FROM expenses
            WHERE organization_id = $1 AND id = $2`, [context.organizationId, expenseId]);
          const branchId = found.rows[0]?.branch_id;
          if (!branchId) throw new ExpenseCancellationError('EXPENSE_CANCELLATION_NOT_AVAILABLE',
            'El gasto no está disponible.');
          await this.cancellations.authorize(client, context, branchId);
          const idempotency = new IdempotencyService(client);
          const acquired = await idempotency.acquire({ actorUserId: context.userId,
            authorizationClass: 'EXPENSE_CANCEL', branchId, key,
            organizationId: context.organizationId, payload: toJsonValue({ expenseId, ...input }),
            scope: 'expense.cancel',
          }, async () => { await this.cancellations.authorize(client, context, branchId); });
          if (acquired.kind === 'replay') {
            const value = acquired.response.body;
            if (typeof value !== 'object' || value === null || Array.isArray(value)
              || typeof value.id !== 'string' || value.expenseId !== expenseId
              || value.status !== 'CANCELLED') throw new TypeError('Invalid persisted cancellation');
            return { result: { id: value.id, expenseId, status: 'CANCELLED' as const } };
          }
          const cash = await this.cancellations.requireCashReturnSession(client, context, expenseId, input);
          const prepared = await this.cancellations.prepare(client, context, expenseId, input.reason);
          await this.cancellations.record(client, context, prepared);
          if (cash) await this.cancellations.recordCashReturn(client, context, prepared, cash);
          const result = { id: prepared.id, expenseId, status: 'CANCELLED' as const };
          await idempotency.complete(acquired.record.id, { statusCode: 201, body: toJsonValue(result) });
          return { result, auditEvent: { action: 'expense.cancelled', entityType: 'expense',
            entityId: expenseId, operationId: prepared.id, branchId: prepared.branchId,
            deviceId: cash?.deviceId ?? null,
            before: { status: 'CONFIRMED' }, beforeAllowlist: ['status'],
            after: { status: 'CANCELLED' }, afterAllowlist: ['status'],
            context: { reason: prepared.reason, method: prepared.method },
            contextAllowlist: ['reason', 'method'] } };
        });
      } catch (error) {
        const code = error instanceof Object && 'code' in error ? error.code : undefined;
        if (code !== '40P01' && code !== '40001' || attempt === 3) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 5 * attempt));
      }
    }
    throw new Error('Expense cancellation retry exhausted');
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
