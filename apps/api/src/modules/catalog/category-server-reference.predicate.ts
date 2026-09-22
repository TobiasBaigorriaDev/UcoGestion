import type { PoolClient } from 'pg';

export type CategoryKind = 'CATALOG' | 'EXPENSE';

export interface CategoryReferenceTarget {
  readonly categoryId: string;
  readonly categoryKind: CategoryKind;
  readonly organizationId: string;
}

export interface CategoryServerReferencePredicate {
  check(client: PoolClient, target: CategoryReferenceTarget): Promise<boolean>;
}

export class CategoryReferenceScopeError extends Error {
  readonly code = 'CATEGORY_REFERENCE_SCOPE_INVALID';

  constructor() {
    super('La categoría no pertenece al contexto tenant activo.');
    this.name = 'CategoryReferenceScopeError';
  }
}

export class PostgresCategoryServerReferencePredicate implements CategoryServerReferencePredicate {
  async check(client: PoolClient, target: CategoryReferenceTarget): Promise<boolean> {
    const tables = tableNames(target.categoryKind);
    const category = await client.query<{ id: string }>(
      `SELECT id FROM ${tables.category}
       WHERE organization_id = $1 AND id = $2`,
      [target.organizationId, target.categoryId],
    );
    if (!category.rows.at(0)) throw new CategoryReferenceScopeError();

    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ${tables.references}
         WHERE organization_id = $1 AND category_id = $2
       ) AS exists`,
      [target.organizationId, target.categoryId],
    );
    return result.rows.at(0)?.exists === true;
  }
}

function tableNames(kind: CategoryKind): { readonly category: string; readonly references: string } {
  return kind === 'CATALOG'
    ? { category: 'catalog_categories', references: 'catalog_category_history_references' }
    : { category: 'expense_categories', references: 'expense_category_history_references' };
}
