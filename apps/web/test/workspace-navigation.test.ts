import { describe, expect, it } from 'vitest';

import { workspaceNavigation, workspaceCurrentPath } from '../src/features/identity/workspace-navigation';

const hrefs = (role: Parameters<typeof workspaceNavigation>[0]) =>
  workspaceNavigation(role).groups.flatMap(group => group.items.map(item => item.href));

describe('D08 workspace navigation', () => {
  it('groups the owner menu by task with every existing section reachable', () => {
    const { groups, primary } = workspaceNavigation('OWNER');
    expect(groups.map(group => group.label)).toEqual(['Inicio', 'Vender', 'Caja', 'Stock', 'Clientes y proveedores', 'Dinero', 'Ajustes']);
    expect(hrefs('OWNER').sort()).toEqual([
      '/workspace', '/workspace/audit', '/workspace/branches', '/workspace/cash-registers', '/workspace/cash-sessions',
      '/workspace/catalog', '/workspace/customers', '/workspace/expense-categories', '/workspace/expenses',
      '/workspace/offline', '/workspace/payment-methods', '/workspace/pos', '/workspace/purchases', '/workspace/reports',
      '/workspace/sales', '/workspace/settings', '/workspace/suppliers', '/workspace/users',
    ]);
    expect(primary.map(item => item.label)).toEqual(['Inicio', 'Mostrador', 'Turno de caja']);
    expect(groups.flatMap(group => group.items).every(item => item.icon)).toBe(true);
  });

  it('keeps the previous role visibility for sales, purchases, expenses and administration', () => {
    expect(hrefs('CASHIER')).toContain('/workspace/pos');
    expect(hrefs('CASHIER')).not.toContain('/workspace/purchases');
    expect(hrefs('CASHIER')).not.toContain('/workspace/users');
    expect(hrefs('ADMIN')).toContain('/workspace/audit');
  });

  it('shows employees only stock-related work and no cash or sales destinations', () => {
    const employee = hrefs('EMPLOYEE');
    for (const hidden of ['/workspace/pos', '/workspace/sales', '/workspace/expenses', '/workspace/cash-sessions',
      '/workspace/cash-registers', '/workspace/offline', '/workspace/users']) expect(employee).not.toContain(hidden);
    expect(employee).toContain('/workspace/purchases');
    expect(workspaceNavigation('EMPLOYEE').primary.map(item => item.label)).toEqual(['Inicio', 'Productos', 'Compras']);
  });

  it('marks catalog sub-pages and home with their menu entry', () => {
    expect(workspaceCurrentPath('home')).toBe('/workspace');
    expect(workspaceCurrentPath('inventory-transfers')).toBe('/workspace/catalog');
    expect(workspaceCurrentPath('cash-sessions')).toBe('/workspace/cash-sessions');
  });
});
