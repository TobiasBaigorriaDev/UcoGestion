import { cleanup, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, expect, it } from 'vitest';

import { CatalogInventoryNavigation } from '../src/features/catalog/catalog-inventory-navigation.js';

afterEach(cleanup);

it('groups catalog and inventory tasks for an administrator and marks the active route', async () => {
  const { container } = render(<CatalogInventoryNavigation role="ADMIN" page="inventory-adjustments" />);
  const navigation = screen.getByRole('navigation', { name: 'Catálogo e inventario' });
  for (const name of ['Productos', 'Historial de ajustes', 'Transferencias', 'Categorías']) {
    expect(within(navigation).getByRole('link', { name })).toBeTruthy();
  }
  expect(screen.getByRole('link', { name: 'Historial de ajustes' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: 'Productos' }).getAttribute('href')).toBe('/workspace/catalog');
  expect(screen.queryByRole('link', { name: 'Ítems' })).toBeNull();
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

it('keeps the product tab selected for an existing items bookmark', () => {
  render(<CatalogInventoryNavigation role="OWNER" page="catalog-items" />);
  expect(screen.getByRole('link', { name: 'Productos' }).getAttribute('aria-current')).toBe('page');
});

it('keeps financial and stock mutation destinations out of the cashier section menu', () => {
  render(<CatalogInventoryNavigation role="CASHIER" page="inventory" />);
  expect(screen.queryByRole('link', { name: 'Stock' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Historial de ajustes' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Transferencias' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Ítems' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Categorías' })).toBeNull();
});
