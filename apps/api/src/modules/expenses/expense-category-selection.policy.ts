import type { PoolClient } from 'pg';

export interface ActiveExpenseCategory {
  readonly id: string;
  readonly name: string;
  readonly status: 'ACTIVE';
  readonly version: number;
}

export type ExpenseCategorySelectionErrorCode =
  | 'EXPENSE_CATEGORY_INACTIVE'
  | 'EXPENSE_CATEGORY_NOT_AVAILABLE';

export class ExpenseCategorySelectionError extends Error {
  constructor(
    readonly code: ExpenseCategorySelectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExpenseCategorySelectionError';
  }
}

export class ExpenseCategorySelectionPolicy {
  async requireActive(
    client: PoolClient,
    organizationId: string,
    expenseCategoryId: string,
  ): Promise<ActiveExpenseCategory> {
    const result = await client.query<{
      id: string;
      name: string;
      status: string;
      version: number;
    }>(
      `SELECT id, name, status, version::integer AS version
       FROM expense_categories
       WHERE organization_id = $1 AND id = $2
       FOR SHARE`,
      [organizationId, expenseCategoryId],
    );
    const row = result.rows.at(0);
    if (!row) {
      throw new ExpenseCategorySelectionError(
        'EXPENSE_CATEGORY_NOT_AVAILABLE',
        'La categoría de gasto no está disponible en la organización.',
      );
    }
    if (row.status !== 'ACTIVE') {
      throw new ExpenseCategorySelectionError(
        'EXPENSE_CATEGORY_INACTIVE',
        'La categoría de gasto está inactiva y no admite nuevos gastos.',
      );
    }
    return { id: row.id, name: row.name, status: 'ACTIVE', version: row.version };
  }
}
