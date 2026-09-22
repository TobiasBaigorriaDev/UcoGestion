export type CategoryStatus = 'ACTIVE' | 'INACTIVE';
export type CategoryOfflineSafety = 'BARRIER_CONFIRMED_CLEAR' | 'EXPOSED' | 'NOT_INTEGRATED';

export interface CategoryStatusTransitionInput {
  readonly currentStatus: CategoryStatus;
  readonly targetStatus: CategoryStatus;
}

export interface CategoryPhysicalDeletionInput {
  readonly hasServerReferences: boolean;
  readonly offlineSafety: CategoryOfflineSafety;
}

export type CategoryLifecycleErrorCode =
  | 'CATEGORY_DELETE_BARRIER_NOT_INTEGRATED'
  | 'CATEGORY_DELETE_BLOCKED_BY_HISTORY'
  | 'CATEGORY_DELETE_BLOCKED_BY_OFFLINE_EXPOSURE'
  | 'CATEGORY_STATUS_UNCHANGED';

export class CategoryLifecycleError extends Error {
  constructor(
    readonly code: CategoryLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CategoryLifecycleError';
  }
}

export class CategoryLifecyclePolicy {
  requireStatusTransition(input: CategoryStatusTransitionInput): { readonly status: CategoryStatus } {
    if (input.currentStatus === input.targetStatus) {
      throw new CategoryLifecycleError(
        'CATEGORY_STATUS_UNCHANGED',
        'La categoría ya se encuentra en el estado solicitado.',
      );
    }
    return { status: input.targetStatus };
  }

  requirePhysicalDeletion(input: CategoryPhysicalDeletionInput): { readonly deletable: true } {
    if (input.hasServerReferences) {
      throw new CategoryLifecycleError(
        'CATEGORY_DELETE_BLOCKED_BY_HISTORY',
        'La categoría posee referencias históricas y solo puede desactivarse.',
      );
    }
    if (input.offlineSafety === 'EXPOSED') {
      throw new CategoryLifecycleError(
        'CATEGORY_DELETE_BLOCKED_BY_OFFLINE_EXPOSURE',
        'La categoría pudo ser usada por operaciones offline pendientes y solo puede desactivarse.',
      );
    }
    if (input.offlineSafety === 'NOT_INTEGRATED') {
      throw new CategoryLifecycleError(
        'CATEGORY_DELETE_BARRIER_NOT_INTEGRATED',
        'La eliminación física no está disponible hasta integrar la barrera offline D01.',
      );
    }
    return { deletable: true };
  }
}
