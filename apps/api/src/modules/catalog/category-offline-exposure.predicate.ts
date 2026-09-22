import type { CategoryOfflineSafety } from './category-lifecycle.policy.js';
import type { CategoryReferenceTarget } from './category-server-reference.predicate.js';

export interface CategoryOfflineExposurePredicate {
  check(target: CategoryReferenceTarget): Promise<CategoryOfflineSafety>;
}

export class UnintegratedCategoryOfflineExposurePredicate implements CategoryOfflineExposurePredicate {
  async check(target: CategoryReferenceTarget): Promise<CategoryOfflineSafety> {
    void target;
    return 'NOT_INTEGRATED';
  }
}
