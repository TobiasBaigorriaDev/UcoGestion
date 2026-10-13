'use client';

import { useState } from 'react';
import type { StockItem } from '../inventory/inventory-api';
import { InventoryAdjustments } from '../inventory/inventory-adjustments';
import { InventoryStock } from '../inventory/inventory-stock';
import styles from './catalog-item-management.module.css';

export function CatalogProductStockActions({ organizationId, role, stock, onReload }: {
  organizationId: string; role: 'OWNER' | 'ADMIN' | 'EMPLOYEE' | 'CASHIER';
  stock: StockItem; onReload: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (role === 'CASHIER') return null;
  return <div className={styles.stockActions}>
    <button type="button" aria-expanded={open} aria-controls={`product-stock-${stock.itemId}`} onClick={() => setOpen(!open)}>Cambiar stock de {stock.itemName}</button>
    {open ? <div id={`product-stock-${stock.itemId}`} className={styles.stockBody}>
    <InventoryAdjustments compact organizationId={organizationId} role={role} branchId={stock.branchId}
      stocks={[stock]} adjustments={[]} nextCursor={null} onReload={onReload} />
    <InventoryStock compact organizationId={organizationId} role={role} branches={[]} branchId={stock.branchId}
      stocks={[stock]} nextCursor={null} onBranchChange={() => undefined} onReload={onReload} />
    </div> : null}
  </div>;
}
