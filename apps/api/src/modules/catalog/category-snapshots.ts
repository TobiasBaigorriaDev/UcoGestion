import type { PoolClient } from 'pg';

export interface CatalogCategorySnapshot {
  readonly id: string;
  readonly name: string;
}

/** Caller holds item locks; retain assigned categories, including inactive ones,
 * under the same contextual tenant transaction until the document commits. */
export async function lockCategorySnapshots(client: PoolClient, organizationId: string,
  categoryIds: readonly string[]): Promise<ReadonlyMap<string, CatalogCategorySnapshot>> {
  const ids = [...new Set(categoryIds)].sort();
  const categories = await client.query<CatalogCategorySnapshot>(
    'SELECT id, name FROM catalog_categories WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
    [organizationId, ids]);
  if (categories.rows.length !== ids.length) throw new Error('Catalog category unavailable');
  return new Map(categories.rows.map(row => [row.id, { id: row.id, name: row.name }]));
}
