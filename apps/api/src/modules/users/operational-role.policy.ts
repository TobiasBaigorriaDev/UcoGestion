import type { MembershipRole } from './non-owner-membership.policy.js';

export type OperationalCapability =
  | 'AUTHORIZED_TRANSFER'
  | 'CATALOG_COST_READ'
  | 'CATALOG_READ'
  | 'CUSTOMER_ACCESS'
  | 'FINANCIAL_GLOBAL_READ'
  | 'INVENTORY_OPERATE'
  | 'INVENTORY_READ'
  | 'MARGIN_READ'
  | 'OWN_CASH_SESSION_OPERATE'
  | 'POS_USE'
  | 'PURCHASE_MANAGE'
  | 'PURCHASE_RECEIVE';

const capabilitiesByRole: Readonly<Record<'CASHIER' | 'EMPLOYEE', ReadonlySet<OperationalCapability>>> = {
  CASHIER: new Set([
    'CATALOG_READ',
    'CUSTOMER_ACCESS',
    'INVENTORY_READ',
    'OWN_CASH_SESSION_OPERATE',
    'POS_USE',
  ]),
  EMPLOYEE: new Set([
    'AUTHORIZED_TRANSFER',
    'CATALOG_READ',
    'INVENTORY_OPERATE',
    'INVENTORY_READ',
    'PURCHASE_RECEIVE',
  ]),
};

export interface CashSessionOperationContext {
  readonly actorUserId: string;
  readonly role: MembershipRole;
  readonly sessionOwnerUserId: string;
}

export interface CatalogProjectionSource {
  readonly categoryName: null | string;
  readonly id: string;
  readonly lowStock: boolean;
  readonly name: string;
  readonly salePrice: string;
  readonly stock: string;
  readonly stockThreshold: null | string;
  readonly [field: string]: unknown;
}

export interface OperationalCatalogItem {
  readonly categoryName: null | string;
  readonly id: string;
  readonly lowStock: boolean;
  readonly name: string;
  readonly salePrice: string;
  readonly stock: string;
  readonly stockThreshold: null | string;
}

export class OperationalRolePolicyError extends Error {
  readonly code = 'OPERATIONAL_CAPABILITY_FORBIDDEN' as const;

  constructor(role: MembershipRole, capability: OperationalCapability) {
    super(`El rol ${role} no puede usar la capacidad ${capability}.`);
    this.name = 'OperationalRolePolicyError';
  }
}

export class OperationalRolePolicy {
  can(role: MembershipRole, capability: OperationalCapability): boolean {
    return (role === 'CASHIER' || role === 'EMPLOYEE')
      && capabilitiesByRole[role].has(capability);
  }

  require(role: MembershipRole, capability: OperationalCapability): void {
    if (!this.can(role, capability)) {
      throw new OperationalRolePolicyError(role, capability);
    }
  }

  canOperateCashSession(context: CashSessionOperationContext): boolean {
    return this.can(context.role, 'OWN_CASH_SESSION_OPERATE')
      && context.actorUserId === context.sessionOwnerUserId;
  }

  projectCatalogItem(role: MembershipRole, source: CatalogProjectionSource): OperationalCatalogItem {
    this.require(role, 'CATALOG_READ');
    return {
      categoryName: source.categoryName,
      id: source.id,
      lowStock: source.lowStock,
      name: source.name,
      salePrice: source.salePrice,
      stock: source.stock,
      stockThreshold: source.stockThreshold,
    };
  }
}
