import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface ExpenseCategoryCreateInput {
  readonly name: string;
}

export interface ExpenseCategoryResult {
  readonly id: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly version: number;
}

export type ExpenseCategoryManagementErrorCode =
  | 'EXPENSE_CATEGORY_MANAGEMENT_FORBIDDEN'
  | 'EXPENSE_CATEGORY_NAME_INVALID';

export class ExpenseCategoryManagementError extends Error {
  constructor(
    readonly code: ExpenseCategoryManagementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExpenseCategoryManagementError';
  }
}

export class ExpenseCategoryManagementService {
  constructor(private readonly transactions: TenantTransaction) {}

  async create(
    context: TenantTransactionContext,
    input: ExpenseCategoryCreateInput,
  ): Promise<ExpenseCategoryResult> {
    const id = randomUUID();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new ExpenseCategoryManagementError(
        'EXPENSE_CATEGORY_NAME_INVALID',
        'El nombre de la categoría de gasto es obligatorio.',
      );
    }
    return this.transactions.run(
      context,
      {
        action: 'expense_category.created',
        after: { name, status: 'ACTIVE' },
        afterAllowlist: ['name', 'status'],
        before: {},
        beforeAllowlist: [],
        branchId: null,
        context: {},
        contextAllowlist: [],
        entityId: id,
        entityType: 'expense_category',
        operationId: id,
      },
      async (client) => {
        await this.requireOwnerOrAdmin(client, context);
        const result = await client.query<ExpenseCategoryResult>(
          `INSERT INTO expense_categories (id, organization_id, name, status)
           VALUES ($1, $2, $3, 'ACTIVE')
           RETURNING id, name, status, version::integer AS version`,
          [id, context.organizationId, name],
        );
        const row = result.rows.at(0);
        if (!row) throw new Error('La categoría de gasto no fue persistida.');
        return row;
      },
    );
  }

  private async requireOwnerOrAdmin(
    client: PoolClient,
    context: TenantTransactionContext,
  ): Promise<void> {
    const membership = await client.query<{ role: string }>(
      `SELECT role FROM memberships
       WHERE organization_id = $1 AND user_id = $2
         AND status = 'ACTIVE' AND revoked_at IS NULL`,
      [context.organizationId, context.userId],
    );
    if (!['OWNER', 'ADMIN'].includes(membership.rows.at(0)?.role ?? '')) {
      throw new ExpenseCategoryManagementError(
        'EXPENSE_CATEGORY_MANAGEMENT_FORBIDDEN',
        'Solo OWNER o ADMIN pueden administrar categorías de gasto.',
      );
    }
  }
}
