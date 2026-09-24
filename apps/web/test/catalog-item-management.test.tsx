import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { CatalogItemManagement } from '../src/features/catalog/catalog-item-management.js';

afterEach(cleanup);

const item = { id: 'item-a', name: 'Yerba', type: 'PRODUCT' as const, status: 'ACTIVE' as const,
  trackInventory: true, baseUnit: 'UNIT' as const, price: '100.00', priceVersion: 1,
  sku: 'Y-1', barcode: null, version: 2 };

it('creates products with nonstructural fields, warns on names, and edits price separately', async () => {
  const create = vi.fn().mockResolvedValue(item);
  const edit = vi.fn().mockResolvedValue({ id: item.id, name: 'Yerba nueva', sku: 'Y-2', barcode: null, version: 3 });
  const price = vi.fn().mockResolvedValue({ itemId: item.id, price: '150.00', priceVersion: 2, version: 3, currency: 'ARS' });
  const lookup = vi.fn().mockResolvedValue(['Yerba']);
  const { container } = render(<CatalogItemManagement organizationId="org" items={[item]} onReload={vi.fn()}
    onCreate={create} onEdit={edit} onPrice={price} onLookupSimilar={lookup} />);
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre del ítem nuevo' }), 'Yerba extra');
  await userEvent.tab();
  expect(await screen.findByText('Posibles duplicados detectados:')).toBeTruthy();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Controlar inventario' }));
  await userEvent.click(screen.getByRole('button', { name: 'Crear ítem' }));
  expect(create).toHaveBeenCalledWith('org', expect.objectContaining({ name: 'Yerba extra', type: 'PRODUCT', trackInventory: true }));
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  await userEvent.clear(screen.getByRole('textbox', { name: 'Nombre de Yerba' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de Yerba' }), 'Yerba nueva');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios de Yerba' }));
  expect(edit).toHaveBeenCalledWith('org', 'item-a', 2, expect.objectContaining({ name: 'Yerba nueva' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar precio de Yerba' }));
  await userEvent.clear(screen.getByRole('textbox', { name: 'Precio nuevo de Yerba' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Precio nuevo de Yerba' }), '150.00');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar precio de Yerba' }));
  expect(price).toHaveBeenCalledWith('org', 'item-a', 2, '150.00');
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

it('keeps structural controls out of nonstructural editing', async () => {
  render(<CatalogItemManagement organizationId="org" items={[item]} onReload={vi.fn()}
    onCreate={vi.fn()} onEdit={vi.fn()} onPrice={vi.fn()} onLookupSimilar={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  expect(screen.queryByRole('checkbox', { name: 'Controlar inventario de Yerba' })).toBeNull();
  expect(screen.getByText('Producto · Unidad · Control de inventario')).toBeTruthy();
});
