import styles from './catalog-inventory-navigation.module.css';

export type CatalogInventoryPage = 'catalog' | 'catalog-items' | 'catalog-categories'
  | 'inventory' | 'inventory-adjustments' | 'inventory-transfers';

type Role = 'OWNER' | 'ADMIN' | 'EMPLOYEE' | 'CASHIER';

const destinations: readonly { page: CatalogInventoryPage; href: string; label: string }[] = [
  { page: 'catalog', href: '/workspace/catalog', label: 'Productos' },
  { page: 'inventory-adjustments', href: '/workspace/inventory/adjustments', label: 'Historial de ajustes' },
  { page: 'inventory-transfers', href: '/workspace/inventory/transfers', label: 'Transferencias' },
  { page: 'catalog-categories', href: '/workspace/catalog/categories', label: 'Categorías' },
];

export function isCatalogInventoryPage(page: string): page is CatalogInventoryPage {
  return page === 'inventory' || page === 'catalog-items' || destinations.some(destination => destination.page === page);
}

export function CatalogInventoryNavigation({ role, page }: { role: Role; page: CatalogInventoryPage }) {
  const visible = destinations.filter(destination => {
    if (role === 'CASHIER' && (destination.page === 'inventory-adjustments'
      || destination.page === 'inventory-transfers')) return false;
    if (role !== 'OWNER' && role !== 'ADMIN' && destination.page === 'catalog-categories') return false;
    return true;
  });
  return <nav className={styles.navigation} aria-label="Catálogo e inventario">
    {visible.map(destination => <a key={destination.page} href={destination.href}
      aria-current={page === destination.page || (page === 'catalog-items' && destination.page === 'catalog') ? 'page' : undefined}>
      {destination.label}
    </a>)}
  </nav>;
}
