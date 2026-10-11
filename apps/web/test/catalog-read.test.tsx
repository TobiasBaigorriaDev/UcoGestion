import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { CatalogReadView } from '../src/features/catalog/catalog-read.js';

afterEach(cleanup);

const data = { items: [
  { id: '1', name: 'Yerba', type: 'PRODUCT' as const, status: 'ACTIVE' as const, baseUnit: 'UNIT' as const, price: '123.00', priceVersion: 1, sku: null, barcode: null },
], categories: [{ id: '2', name: 'Almacén' }] };

it.each(['OWNER', 'ADMIN'] as const)('offers visible management actions for %s', (role) => {
  render(<CatalogReadView role={role} data={data} loadHistory={vi.fn()} />);
  const items = screen.getByRole('link', { name: 'Administrar ítems' });
  const categories = screen.getByRole('link', { name: 'Administrar categorías de catálogo' });
  expect(items.getAttribute('href')).toBe('/workspace/catalog/items');
  expect(categories.getAttribute('href')).toBe('/workspace/catalog/categories');
  expect(items.classList.contains('uco-button')).toBe(true);
  expect(categories.classList.contains('uco-button')).toBe(true);
});

it.each(['CASHIER', 'EMPLOYEE'] as const)('keeps management actions unavailable for %s', (role) => {
  render(<CatalogReadView role={role} data={data} loadHistory={vi.fn()} />);
  expect(screen.queryByRole('link', { name: /Administrar/ })).toBeNull();
});

it('searches by name, SKU and barcode and recovers after no matches', async () => {
  const user = userEvent.setup();
  render(<CatalogReadView role="OWNER" data={{ ...data, items: [
    { ...data.items[0]!, name: 'Café molido', sku: 'CAFE-01', barcode: '7791234567890' },
    { ...data.items[0]!, id: '3', name: 'Yerba' },
  ] }} loadHistory={vi.fn()} />);
  const search = screen.getByRole('searchbox', { name: 'Buscar producto' });
  for (const query of ['  cafe  ', 'cafe-01', '7791234567890']) {
    await user.clear(search);
    await user.type(search, query);
    expect(screen.getByText('Café molido')).toBeTruthy();
    expect(screen.queryByText('Yerba')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('1 de 2 ítems');
  }
  await user.clear(search);
  await user.type(search, 'inexistente');
  expect(screen.getByText('No encontramos ítems con esa búsqueda. Probá con otro nombre, SKU o código de barras.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Limpiar búsqueda' }));
  expect(screen.getByText('Café molido')).toBeTruthy();
  expect(screen.getByText('Yerba')).toBeTruthy();
  expect(document.activeElement).toBe(search);
});

it('shows active catalog prices and categories without edit controls', async () => {
  const { container } = render(<CatalogReadView role="CASHIER" data={data} loadHistory={vi.fn()} />);
  expect(screen.getByText('Yerba')).toBeTruthy();
  expect(screen.getByText('123.00')).toBeTruthy();
  expect(screen.getByText('Almacén')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /editar|borrar|desactivar/i })).toBeNull();
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

it('loads historical inactive items only when an employee explicitly requests branch context', async () => {
  const loadHistory = vi.fn().mockResolvedValue({ ...data, items: [...data.items, { ...data.items[0], id: '3', name: 'Antiguo', status: 'INACTIVE' }] });
  render(<CatalogReadView role="EMPLOYEE" data={data} branchId="branch-a" loadHistory={loadHistory} />);
  expect(screen.queryByText('Antiguo')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Ver ítems inactivos de esta sucursal' }));
  expect(await screen.findByText('Antiguo')).toBeTruthy();
  expect(loadHistory).toHaveBeenCalledWith('branch-a');
});
