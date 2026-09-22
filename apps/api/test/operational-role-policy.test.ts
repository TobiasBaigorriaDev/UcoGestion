import { describe, expect, it } from 'vitest';

import {
  OperationalRolePolicy,
  OperationalRolePolicyError,
  type OperationalCapability,
} from '../src/modules/users/operational-role.policy.js';

describe('CASHIER and EMPLOYEE operational role policies', () => {
  const policy = new OperationalRolePolicy();

  it('allows CASHIER only POS, customer, assigned read access and its own cash session', () => {
    const allowed: readonly OperationalCapability[] = [
      'CATALOG_READ',
      'CUSTOMER_ACCESS',
      'INVENTORY_READ',
      'OWN_CASH_SESSION_OPERATE',
      'POS_USE',
    ];
    const denied: readonly OperationalCapability[] = [
      'CATALOG_COST_READ',
      'FINANCIAL_GLOBAL_READ',
      'INVENTORY_OPERATE',
      'MARGIN_READ',
      'PURCHASE_MANAGE',
      'PURCHASE_RECEIVE',
    ];

    for (const capability of allowed) expect(policy.can('CASHIER', capability)).toBe(true);
    for (const capability of denied) expect(policy.can('CASHIER', capability)).toBe(false);

    expect(policy.canOperateCashSession({
      actorUserId: 'cashier-a',
      role: 'CASHIER',
      sessionOwnerUserId: 'cashier-a',
    })).toBe(true);
    expect(policy.canOperateCashSession({
      actorUserId: 'cashier-a',
      role: 'CASHIER',
      sessionOwnerUserId: 'cashier-b',
    })).toBe(false);
  });

  it('allows EMPLOYEE catalog, inventory, receipt and authorized transfers without POS, finance or cash', () => {
    const allowed: readonly OperationalCapability[] = [
      'AUTHORIZED_TRANSFER',
      'CATALOG_READ',
      'INVENTORY_OPERATE',
      'INVENTORY_READ',
      'PURCHASE_RECEIVE',
    ];
    const denied: readonly OperationalCapability[] = [
      'CATALOG_COST_READ',
      'CUSTOMER_ACCESS',
      'FINANCIAL_GLOBAL_READ',
      'MARGIN_READ',
      'OWN_CASH_SESSION_OPERATE',
      'POS_USE',
      'PURCHASE_MANAGE',
    ];

    for (const capability of allowed) expect(policy.can('EMPLOYEE', capability)).toBe(true);
    for (const capability of denied) expect(policy.can('EMPLOYEE', capability)).toBe(false);
    expect(policy.canOperateCashSession({
      actorUserId: 'employee-a',
      role: 'EMPLOYEE',
      sessionOwnerUserId: 'employee-a',
    })).toBe(false);
  });

  it('rejects forbidden capabilities with a stable policy error', () => {
    expect(() => policy.require('CASHIER', 'PURCHASE_MANAGE')).toThrow(OperationalRolePolicyError);

    try {
      policy.require('EMPLOYEE', 'FINANCIAL_GLOBAL_READ');
      throw new Error('Expected OperationalRolePolicyError.');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationalRolePolicyError);
      expect((error as OperationalRolePolicyError).code).toBe('OPERATIONAL_CAPABILITY_FORBIDDEN');
    }
  });

  it.each(['CASHIER', 'EMPLOYEE'] as const)(
    'projects an explicit catalog allowlist for %s without cost, margin or global finance fields',
    (role) => {
      const source = {
        categoryName: 'Bebidas',
        globalFinancialSummary: '999999.99',
        id: 'item-1',
        lowStock: false,
        margin: '35.00',
        name: 'Agua mineral',
        purchaseCost: '100.00',
        salePrice: '150.00',
        stock: '8.000',
        stockThreshold: '2.000',
      };

      const projected = policy.projectCatalogItem(role, source);

      expect(projected).toEqual({
        categoryName: 'Bebidas',
        id: 'item-1',
        lowStock: false,
        name: 'Agua mineral',
        salePrice: '150.00',
        stock: '8.000',
        stockThreshold: '2.000',
      });
      expect(projected).not.toHaveProperty('purchaseCost');
      expect(projected).not.toHaveProperty('margin');
      expect(projected).not.toHaveProperty('globalFinancialSummary');
    },
  );
});
