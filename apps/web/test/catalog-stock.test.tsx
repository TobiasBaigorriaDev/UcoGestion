import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { CatalogStockSummary } from '../src/features/catalog/catalog-stock-summary.js';
import { loadAllStocks } from '../src/features/inventory/inventory-api.js';

afterEach(cleanup);

it('shows fractional stock with a decimal comma and without trailing zeroes', () => {
  render(<CatalogStockSummary item={{ id: 'item-a', type: 'PRODUCT', status: 'ACTIVE', trackInventory: true }}
    branchName="Centro" stocks={[{ ...stock, baseUnit: 'FRACTIONAL', quantity: '1.250' }]} />);
  expect(screen.getByText('1,25 unidades fraccionables')).toBeTruthy();
});

const stock = { branchId: 'branch-a', itemId: 'item-a', itemName: 'Yerba',
  baseUnit: 'UNIT' as const, quantity: '2.000', threshold: '3.000', lowStock: true };

it('loads every stock page before presenting catalog quantities', async () => {
  const loadPage = vi.fn().mockResolvedValueOnce({ stocks: [stock], nextCursor: 'item-a' })
    .mockResolvedValueOnce({ stocks: [{ ...stock, itemId: 'item-b', quantity: '0.000' }], nextCursor: null });
  expect(await loadAllStocks('org', 'branch-a', loadPage)).toEqual([stock, { ...stock, itemId: 'item-b', quantity: '0.000' }]);
  expect(loadPage).toHaveBeenNthCalledWith(1, 'org', 'branch-a', undefined);
  expect(loadPage).toHaveBeenNthCalledWith(2, 'org', 'branch-a', 'item-a');
});

it('rejects stock rows from a different branch', async () => {
  const loadPage = vi.fn().mockResolvedValue({ stocks: [{ ...stock, branchId: 'branch-b' }], nextCursor: null });
  await expect(loadAllStocks('org', 'branch-a', loadPage)).rejects.toThrow('Stock branch mismatch');
});

it('shows branch stock and low stock in words, without inventing missing quantities', () => {
  const { rerender } = render(<CatalogStockSummary item={{ id: 'item-a', type: 'PRODUCT', status: 'ACTIVE', trackInventory: true }}
    branchName="Centro" stocks={[stock]} />);
  expect(screen.getByText(/Disponible en Centro:/)).toBeTruthy();
  expect(screen.getByText('2 unidades')).toBeTruthy();
  expect(screen.getByText('Stock bajo')).toBeTruthy();
  rerender(<CatalogStockSummary item={{ id: 'item-b', type: 'PRODUCT', status: 'ACTIVE', trackInventory: true }}
    branchName="Centro" stocks={[stock]} />);
  expect(screen.getByText('Stock no disponible en Centro')).toBeTruthy();
  expect(screen.queryByText(/0 unidades/)).toBeNull();
});

it('distinguishes services, non-inventory items, inactive products and missing branch context', () => {
  const { rerender } = render(<CatalogStockSummary item={{ id: 's', type: 'SERVICE', status: 'ACTIVE', trackInventory: false }}
    branchName="Centro" stocks={[]} />);
  expect(screen.getByText('Servicio · sin stock')).toBeTruthy();
  rerender(<CatalogStockSummary item={{ id: 'p', type: 'PRODUCT', status: 'ACTIVE', trackInventory: false }}
    branchName="Centro" stocks={[]} />);
  expect(screen.getByText('No controla stock')).toBeTruthy();
  rerender(<CatalogStockSummary item={{ id: 'p', type: 'PRODUCT', status: 'INACTIVE', trackInventory: true }}
    branchName="Centro" stocks={[]} />);
  expect(screen.getByText('Inactivo · sin stock actual')).toBeTruthy();
  rerender(<CatalogStockSummary item={{ id: 'p', type: 'PRODUCT', status: 'ACTIVE', trackInventory: true }}
    stocks={[]} />);
  expect(screen.getByText('Seleccioná una sucursal para ver stock')).toBeTruthy();
});
