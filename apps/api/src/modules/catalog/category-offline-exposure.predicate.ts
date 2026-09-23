import type { PoolClient } from 'pg';

import type { CategoryOfflineSafety } from './category-lifecycle.policy.js';
import type { CategoryReferenceTarget } from './category-server-reference.predicate.js';

export interface CategoryOfflineExposurePredicate {
  check(target: CategoryReferenceTarget, client?: PoolClient): Promise<CategoryOfflineSafety>;
  check(client: PoolClient, target: CategoryReferenceTarget): Promise<CategoryOfflineSafety>;
}

export class UnintegratedCategoryOfflineExposurePredicate implements CategoryOfflineExposurePredicate {
  async check(
    first: CategoryReferenceTarget | PoolClient,
    second?: CategoryReferenceTarget | PoolClient,
  ): Promise<CategoryOfflineSafety> {
    void first;
    void second;
    return 'NOT_INTEGRATED';
  }
}

export class PostgresCategoryOfflineExposurePredicate implements CategoryOfflineExposurePredicate {
  async check(
    first: CategoryReferenceTarget | PoolClient,
    second?: CategoryReferenceTarget | PoolClient,
  ): Promise<CategoryOfflineSafety> {
    const client = 'query' in first ? first : (second as PoolClient);
    const target = 'query' in first ? (second as CategoryReferenceTarget) : first;

    const barrier = await client.query(
      `SELECT 1 FROM configuration_barriers WHERE organization_id = $1 AND status = 'ACTIVE'`,
      [target.organizationId],
    );
    if ((barrier.rowCount ?? 0) > 0) return 'EXPOSED';

    const exposure = await client.query(
      `SELECT 1 FROM offline_exposure_resources r
       JOIN offline_configuration_exposures e ON e.organization_id = r.organization_id
         AND e.id = r.exposure_id
       WHERE r.organization_id = $1 AND r.catalog_category_id = $2 AND e.cleared_at IS NULL LIMIT 1`,
      [target.organizationId, target.categoryId],
    );
    return (exposure.rowCount ?? 0) > 0 ? 'EXPOSED' : 'BARRIER_CONFIRMED_CLEAR';
  }
}
