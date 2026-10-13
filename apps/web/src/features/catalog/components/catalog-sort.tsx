'use client';

import { useId } from 'react';
import type { StockItem } from '../../inventory/inventory-api';
import styles from './catalog-sort.module.css';

const options = [
  { value: 'name-asc', label: 'Nombre: A–Z' },
  { value: 'name-desc', label: 'Nombre: Z–A' },
  { value: 'price-asc', label: 'Precio: menor a mayor' },
  { value: 'price-desc', label: 'Precio: mayor a menor' },
  { value: 'stock-asc', label: 'Stock: menor a mayor' },
  { value: 'stock-desc', label: 'Stock: mayor a menor' },
  { value: 'stock-low', label: 'Stock bajo primero' },
] as const;
export type CatalogOrder = typeof options[number]['value'];

type SortableItem = { id: string; name: string; price: string | null; type: 'PRODUCT' | 'SERVICE'; status: 'ACTIVE' | 'INACTIVE'; trackInventory: boolean };

// Compare canonical decimals exactly, including balances from offline conflicts.
function compareDecimal(left: string, right: string): number {
  const [leftInteger = '0', leftFraction = ''] = left.split('.');
  const [rightInteger = '0', rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const a = BigInt(leftInteger + leftFraction.padEnd(scale, '0'));
  const b = BigInt(rightInteger + rightFraction.padEnd(scale, '0'));
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortCatalogItems<T extends SortableItem>(items: readonly T[], order: CatalogOrder, stocks?: readonly StockItem[]): T[] {
  const balances = new Map(stocks?.map(stock => [stock.itemId, stock]));
  const names = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
  const stockEntry = (item: T) => item.type === 'PRODUCT' && item.status === 'ACTIVE' && item.trackInventory ? balances.get(item.id) : undefined;
  const stockValue = (item: T) => stockEntry(item)?.quantity ?? null;
  const lowStockRank = (item: T) => {
    const stock = stockEntry(item);
    if (!stock) return 2;
    return stock.threshold !== null && stock.lowStock ? 0 : 1;
  };
  return [...items].sort((a, b) => {
    const tie = names.compare(a.name, b.name) || a.id.localeCompare(b.id);
    if (order === 'name-asc') return tie;
    if (order === 'name-desc') return -tie;
    if (order === 'stock-low') return lowStockRank(a) - lowStockRank(b) || tie;
    const left = order.startsWith('price') ? a.price : stockValue(a);
    const right = order.startsWith('price') ? b.price : stockValue(b);
    if (left === null) return right === null ? tie : 1;
    if (right === null) return -1;
    const result = compareDecimal(left, right);
    return (order.endsWith('desc') ? -result : result) || tie;
  });
}

export function CatalogSort({ value, onChange }: { value: CatalogOrder; onChange: (value: CatalogOrder) => void }) {
  const id = useId();
  return <div className={styles.field}>
    <label htmlFor={id}>Ordenar productos</label>
    <select id={id} value={value} onChange={event => {
      const option = options.find(entry => entry.value === event.target.value);
      if (option) onChange(option.value);
    }}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </div>;
}
