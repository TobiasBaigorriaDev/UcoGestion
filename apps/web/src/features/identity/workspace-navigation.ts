import type { NavigationGroup, NavigationItem } from '../../components/app-shell';
import { isCatalogInventoryPage } from '../catalog/catalog-inventory-navigation';

export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';

/** Menu grouped by the task a shop owner has in mind; visibility still mirrors backend roles. */
export function workspaceNavigation(role: WorkspaceRole | undefined): {
  groups: NavigationGroup[]; primary: NavigationItem[];
} {
  const sells = role !== 'EMPLOYEE';
  const manages = role === 'OWNER' || role === 'ADMIN';
  const home: NavigationItem = { href: '/workspace', label: 'Inicio', icon: 'home' };
  const counter: NavigationItem = { href: '/workspace/pos', label: 'Mostrador', icon: 'counter' };
  const shift: NavigationItem = { href: '/workspace/cash-sessions', label: 'Turno de caja', icon: 'wallet' };
  const products: NavigationItem = { href: '/workspace/catalog', label: 'Productos', icon: 'package' };
  const purchases: NavigationItem = { href: '/workspace/purchases', label: 'Compras', icon: 'truck' };
  const groups: NavigationGroup[] = [
    { label: 'Inicio', items: [home] },
    ...(sells ? [{ label: 'Vender', items: [counter, { href: '/workspace/sales', label: 'Ventas', icon: 'receipt' }] } satisfies NavigationGroup] : []),
    ...(sells ? [{ label: 'Caja', items: [shift,
      { href: '/workspace/cash-registers', label: 'Cajas registradoras', icon: 'banknote' },
      { href: '/workspace/offline', label: 'Este equipo sin conexión', icon: 'device' }] } satisfies NavigationGroup] : []),
    { label: 'Stock', items: [products, ...(role === 'CASHIER' ? [] : [purchases])] },
    { label: 'Clientes y proveedores', items: [
      { href: '/workspace/customers', label: 'Clientes', icon: 'users' },
      { href: '/workspace/suppliers', label: 'Proveedores', icon: 'store' }] },
    { label: 'Dinero', items: [
      ...(sells ? [{ href: '/workspace/expenses', label: 'Gastos', icon: 'banknote' } satisfies NavigationItem] : []),
      { href: '/workspace/reports', label: 'Reportes', icon: 'chart' }] },
    { label: 'Ajustes', items: [
      { href: '/workspace/settings', label: 'Negocio', icon: 'sliders' },
      { href: '/workspace/branches', label: 'Sucursales', icon: 'pin' },
      ...(manages ? [
        { href: '/workspace/users', label: 'Usuarios', icon: 'users' },
        { href: '/workspace/payment-methods', label: 'Medios de pago', icon: 'card' },
        { href: '/workspace/expense-categories', label: 'Categorías de gasto', icon: 'tag' },
        { href: '/workspace/audit', label: 'Auditoría', icon: 'shield' },
      ] satisfies NavigationItem[] : [])] },
  ];
  return { groups, primary: sells ? [home, counter, shift] : [home, products, purchases] };
}

export function workspaceCurrentPath(page: string): string {
  if (page === 'home') return '/workspace';
  return isCatalogInventoryPage(page) ? '/workspace/catalog' : `/workspace/${page}`;
}
