import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { CatalogReadView } from '../src/features/catalog/catalog-read.js';

afterEach(cleanup);

const data = { items: [
  { id: '1', name: 'Yerba', type: 'PRODUCT' as const, status: 'ACTIVE' as const, baseUnit: 'UNIT' as const, price: '123.00', priceVersion: 1, sku: null, barcode: null },
], categories: [{ id: '2', name: 'Almacén' }] };

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
