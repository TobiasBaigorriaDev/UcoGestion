import type { ResourceSafety } from '../offline-sync/resource-safety.service.js';

export type CatalogItemStatus = 'ACTIVE' | 'INACTIVE';
export type CatalogItemType = 'PRODUCT' | 'SERVICE';
export type CatalogItemBaseUnit = 'UNIT' | 'FRACTIONAL';

export interface CatalogItemStatusTransitionInput {
  readonly currentStatus: CatalogItemStatus;
  readonly targetStatus: CatalogItemStatus;
}

export interface CatalogItemPhysicalDeletionInput {
  readonly hasServerReferences: boolean;
  readonly offlineSafety: ResourceSafety;
}

export interface CatalogItemStructuralChangeInput {
  readonly current: {
    readonly type: CatalogItemType;
    readonly trackInventory: boolean;
    readonly baseUnit: CatalogItemBaseUnit;
  };
  readonly target: {
    readonly type: CatalogItemType;
    readonly trackInventory: boolean;
    readonly baseUnit: CatalogItemBaseUnit;
  };
  readonly hasServerReferences: boolean;
  readonly offlineSafety: ResourceSafety;
  readonly barrierActive: boolean;
}

export type CatalogItemLifecycleErrorCode =
  | 'CATALOG_ITEM_BASE_UNIT_INVALID'
  | 'CATALOG_ITEM_DELETE_BLOCKED_BY_HISTORY'
  | 'CATALOG_ITEM_DELETE_BLOCKED_BY_OFFLINE_UNCERTAINTY'
  | 'CATALOG_ITEM_SERVICE_TRACK_INVENTORY_NOT_ALLOWED'
  | 'CATALOG_ITEM_STATUS_UNCHANGED'
  | 'CATALOG_ITEM_STRUCTURAL_CHANGE_BLOCKED_BY_HISTORY'
  | 'CATALOG_ITEM_STRUCTURAL_CHANGE_BLOCKED_BY_OFFLINE_UNCERTAINTY'
  | 'CATALOG_ITEM_TYPE_INVALID';

export class CatalogItemLifecycleError extends Error {
  constructor(
    readonly code: CatalogItemLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogItemLifecycleError';
  }
}

export class CatalogItemLifecyclePolicy {
  requireStatusTransition(input: CatalogItemStatusTransitionInput): { readonly status: CatalogItemStatus } {
    if (input.currentStatus === input.targetStatus) {
      throw new CatalogItemLifecycleError(
        'CATALOG_ITEM_STATUS_UNCHANGED',
        'El ítem ya se encuentra en el estado solicitado.',
      );
    }
    return { status: input.targetStatus };
  }

  requirePhysicalDeletion(input: CatalogItemPhysicalDeletionInput): { readonly deletable: true } {
    if (input.hasServerReferences || input.offlineSafety === 'HISTORY') {
      throw new CatalogItemLifecycleError(
        'CATALOG_ITEM_DELETE_BLOCKED_BY_HISTORY',
        'El ítem posee referencias históricas y solo puede desactivarse.',
      );
    }
    if (input.offlineSafety === 'UNCERTAIN') {
      throw new CatalogItemLifecycleError(
        'CATALOG_ITEM_DELETE_BLOCKED_BY_OFFLINE_UNCERTAINTY',
        'El ítem pudo ser utilizado en operaciones offline pendientes y solo puede desactivarse.',
      );
    }
    return { deletable: true };
  }

  requireStructuralChange(input: CatalogItemStructuralChangeInput): {
    readonly baseUnit: CatalogItemBaseUnit;
    readonly trackInventory: boolean;
    readonly type: CatalogItemType;
  } {
    if (input.hasServerReferences || input.offlineSafety === 'HISTORY') {
      throw new CatalogItemLifecycleError(
        'CATALOG_ITEM_STRUCTURAL_CHANGE_BLOCKED_BY_HISTORY',
        'El ítem posee referencias históricas y no permite cambios estructurales.',
      );
    }
    if (input.barrierActive) {
      throw new CatalogItemLifecycleError(
        'CATALOG_ITEM_STRUCTURAL_CHANGE_BLOCKED_BY_OFFLINE_UNCERTAINTY',
        'Hay una barrera de configuración activa en curso.',
      );
    }
    if (input.offlineSafety === 'UNCERTAIN') {
      throw new CatalogItemLifecycleError(
        'CATALOG_ITEM_STRUCTURAL_CHANGE_BLOCKED_BY_OFFLINE_UNCERTAINTY',
        'El ítem puede tener operaciones offline pendientes bajo la configuración actual.',
      );
    }

    if (!['PRODUCT', 'SERVICE'].includes(input.target.type)) {
      throw new CatalogItemLifecycleError(
        'CATALOG_ITEM_TYPE_INVALID',
        'El tipo de ítem debe ser PRODUCT o SERVICE.',
      );
    }
    if (!['UNIT', 'FRACTIONAL'].includes(input.target.baseUnit)) {
      throw new CatalogItemLifecycleError(
        'CATALOG_ITEM_BASE_UNIT_INVALID',
        'La unidad de medida debe ser UNIT o FRACTIONAL.',
      );
    }
    if (input.target.type === 'SERVICE' && input.target.trackInventory) {
      throw new CatalogItemLifecycleError(
        'CATALOG_ITEM_SERVICE_TRACK_INVENTORY_NOT_ALLOWED',
        'Los servicios no pueden tener control de inventario.',
      );
    }

    const trackInventory = input.target.type === 'PRODUCT' ? input.target.trackInventory : false;
    return {
      baseUnit: input.target.baseUnit,
      trackInventory,
      type: input.target.type,
    };
  }
}
