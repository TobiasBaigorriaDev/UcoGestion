import { randomUUID } from 'node:crypto';

import { Money, validatePositiveMoney } from '@uconext/shared';
import type { PoolClient } from 'pg';

import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { ExpenseCategorySelectionPolicy } from './expense-category-selection.policy.js';

export interface ExpenseInput {
  readonly branchId: string;
  readonly categoryId: string;
  readonly concept: string;
  readonly amount: string;
  readonly method: string;
  readonly cashSessionId?: string | undefined;
  readonly deviceId?: string | undefined;
}

export interface ExpenseResult {
  readonly id: string;
  readonly branchId: string;
  readonly categoryId: string;
  readonly concept: string;
  readonly amount: string;
  readonly method: string;
  readonly currency: string;
  readonly actorUserId: string;
  readonly occurredAt: string;
}

export class ExpensePersistenceError extends Error {
  constructor(readonly code: 'EXPENSE_AMOUNT_INVALID' | 'EXPENSE_CONCEPT_INVALID' |
    'EXPENSE_BRANCH_NOT_AVAILABLE' | 'EXPENSE_METHOD_NOT_AVAILABLE', message: string) {
    super(message); this.name = 'ExpensePersistenceError';
  }
}

/** Internal persistence; the caller owns authorization and the tenant transaction. */
export class ExpensePersistence {
  private readonly categories = new ExpenseCategorySelectionPolicy();

  async persist(client: PoolClient, context: TenantTransactionContext,
    input: ExpenseInput & { readonly id: string }): Promise<ExpenseResult> {
    const valid = validatePositiveMoney(input.amount);
    if (!valid) throw new ExpensePersistenceError('EXPENSE_AMOUNT_INVALID', 'El importe debe ser estrictamente positivo.');
    const amount = Money.from(valid).toString();
    const concept = input.concept.trim();
    if (concept.length < 1 || concept.length > 2000) {
      throw new ExpensePersistenceError('EXPENSE_CONCEPT_INVALID', 'El concepto es obligatorio.');
    }
    const branch = await client.query<{ base_currency: string }>(`SELECT o.base_currency FROM branches b
      JOIN organizations o ON o.id = b.organization_id
      WHERE b.organization_id = $1 AND b.id = $2 AND b.status = 'ACTIVE'`,
    [context.organizationId, input.branchId]);
    const currency = branch.rows[0]?.base_currency;
    if (!currency) throw new ExpensePersistenceError('EXPENSE_BRANCH_NOT_AVAILABLE', 'La sucursal no está disponible.');
    await this.categories.requireActive(client, context.organizationId, input.categoryId);
    const method = await client.query<{ enabled: boolean }>(`SELECT enabled FROM payment_method_settings
      WHERE organization_id = $1 AND method = $2 FOR SHARE`, [context.organizationId, input.method]);
    if (!method.rows[0]?.enabled) {
      throw new ExpensePersistenceError('EXPENSE_METHOD_NOT_AVAILABLE', 'El medio de pago no está disponible.');
    }
    const inserted = await client.query<{ occurred_at: Date }>(`INSERT INTO expenses
      (id, organization_id, branch_id, expense_category_id, actor_user_id, concept, amount, method, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING occurred_at`,
    [input.id, context.organizationId, input.branchId, input.categoryId, context.userId,
      concept, amount, input.method, currency]);
    await client.query(`INSERT INTO expense_category_history_references
      (id, organization_id, category_id, reference_type, source_id)
      VALUES ($1, $2, $3, 'EXPENSE', $4)`, [randomUUID(), context.organizationId, input.categoryId, input.id]);
    await client.query(`INSERT INTO organization_history_references
      (id, organization_id, reference_domain, reference_type, source_id)
      VALUES ($1, $2, 'MONETARY', 'EXPENSE', $3)`, [randomUUID(), context.organizationId, input.id]);
    const occurredAt = inserted.rows[0]?.occurred_at;
    if (!occurredAt) throw new Error('El gasto no devolvió fecha de creación.');
    return { id: input.id, branchId: input.branchId, categoryId: input.categoryId,
      concept, amount, method: input.method, currency, actorUserId: context.userId,
      occurredAt: occurredAt.toISOString() };
  }
}
