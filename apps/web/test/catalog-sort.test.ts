import { expect, it } from 'vitest';
import { sortCatalogItems } from '../src/features/catalog/components/catalog-sort';

it('prioritizes configured low-stock alerts rather than the smallest quantities', () => {
  const base = { type: 'PRODUCT' as const, status: 'ACTIVE' as const, trackInventory: true, price: '1.00' };
  const items = [
    { ...base, id: 'a', name: 'Arroz' },
    { ...base, id: 'b', name: 'Bolsa' },
    { ...base, id: 'c', name: 'Café' },
    { ...base, id: 'd', name: 'Dulce', status: 'INACTIVE' as const },
    { ...base, id: 'e', name: 'Envío', type: 'SERVICE' as const },
  ];
  const stocks = items.map(item => ({ branchId: 'branch', itemId: item.id, itemName: item.name,
    baseUnit: 'UNIT' as const, quantity: item.id === 'b' ? '50.000' : '1.000',
    threshold: item.id === 'a' ? null : item.id === 'c' ? '0.000' : '100.000', lowStock: item.id !== 'a' && item.id !== 'c' }));
  expect(sortCatalogItems(items, 'stock-low', stocks).map(item => item.id)).toEqual(['b', 'a', 'c', 'd', 'e']);
  const updated = stocks.map(stock => ({ ...stock, threshold: stock.threshold === null ? null : '0.000', lowStock: false }));
  expect(sortCatalogItems(items, 'stock-low', updated).map(item => item.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(sortCatalogItems(items, 'stock-low').map(item => item.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
});

it('compares fractional stock exactly and excludes inactive, untracked and service balances', () => {
  const base = { type: 'PRODUCT' as const, status: 'ACTIVE' as const, trackInventory: true, price: '1.00' };
  const items = [
    { ...base, id: 'b', name: 'Bolsa' },
    { ...base, id: 'a', name: 'Arroz' },
    { ...base, id: 'c', name: 'Café', status: 'INACTIVE' as const },
    { ...base, id: 'd', name: 'Dulce', trackInventory: false },
    { ...base, id: 'e', name: 'Envío', type: 'SERVICE' as const },
  ];
  const stocks = items.map(item => ({ branchId: 'branch', itemId: item.id, itemName: item.name,
    baseUnit: 'FRACTIONAL' as const, quantity: item.id === 'b' ? '-0.002' : '-0.001', threshold: null, lowStock: false }));
  expect(sortCatalogItems(items, 'stock-asc', stocks).map(item => item.id)).toEqual(['b', 'a', 'c', 'd', 'e']);
  expect(sortCatalogItems(items, 'stock-desc', stocks).map(item => item.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(sortCatalogItems(items, 'price-desc').map(item => item.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
});
