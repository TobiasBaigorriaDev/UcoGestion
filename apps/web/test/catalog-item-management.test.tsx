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
}, 15000);

it('keeps structural controls out of nonstructural editing', async () => {
  render(<CatalogItemManagement organizationId="org" items={[item]} onReload={vi.fn()}
    onCreate={vi.fn()} onEdit={vi.fn()} onPrice={vi.fn()} onLookupSimilar={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  expect(screen.queryByRole('checkbox', { name: 'Controlar inventario de Yerba' })).toBeNull();
  expect(screen.getByText('Producto · Unidad · Control de inventario')).toBeTruthy();
});

it('supports status toggle, physical deletion and structural change', async () => {
  const changeStatus = vi.fn().mockResolvedValue({ ...item, status: 'INACTIVE', version: 3 });
  const deleteItem = vi.fn().mockResolvedValue({ id: item.id, deleted: true });
  const changeStructure = vi.fn().mockResolvedValue({ ...item, type: 'SERVICE', trackInventory: false, baseUnit: 'UNIT', version: 3 });
  const reload = vi.fn();

  render(<CatalogItemManagement organizationId="org" items={[item]} onReload={reload}
    onChangeStatus={changeStatus} onDelete={deleteItem} onChangeStructure={changeStructure} />);

  // Status toggle
  await userEvent.click(screen.getByRole('button', { name: 'Desactivar Yerba' }));
  expect(changeStatus).toHaveBeenCalledWith('org', 'item-a', 2, 'INACTIVE');

  // Deletion flow with confirmation
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar Yerba' }));
  expect(screen.getByText('¿Confirmás eliminar definitivamente Yerba?')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación de Yerba' }));
  expect(deleteItem).toHaveBeenCalledWith('org', 'item-a', 2);

  // Structural change
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar estructura de Yerba' }));
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Tipo estructural de Yerba' }), 'SERVICE');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar estructura de Yerba' }));
  expect(changeStructure).toHaveBeenCalledWith('org', 'item-a', 2, {
    type: 'SERVICE',
    baseUnit: 'UNIT',
    trackInventory: false,
  });
});

it('displays differentiated D01 error messages for delete and structural change', async () => {
  const deleteItemBlockedHistory = vi.fn().mockRejectedValue({
    status: 409,
    code: 'CATALOG_ITEM_DELETE_BLOCKED_BY_HISTORY',
    message: 'Bloqueado por historial',
  });
  const deleteItemBlockedOffline = vi.fn().mockRejectedValue({
    status: 409,
    code: 'CATALOG_ITEM_DELETE_BLOCKED_BY_OFFLINE_UNCERTAINTY',
    message: 'Bloqueado por offline',
  });
  const changeStructureBlockedHistory = vi.fn().mockRejectedValue({
    status: 409,
    code: 'CATALOG_ITEM_STRUCTURAL_CHANGE_BLOCKED_BY_HISTORY',
    message: 'Cambio estructural bloqueado por historial',
  });
  const changeStructureBlockedOffline = vi.fn().mockRejectedValue({
    status: 409,
    code: 'CATALOG_ITEM_STRUCTURAL_CHANGE_BLOCKED_BY_OFFLINE_UNCERTAINTY',
    message: 'Cambio estructural bloqueado por incertidumbre',
  });

  // Delete blocked by history
  const { unmount: unmount1 } = render(<CatalogItemManagement organizationId="org" items={[item]} onReload={vi.fn()}
    onDelete={deleteItemBlockedHistory} />);
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación de Yerba' }));
  expect(await screen.findByText(/referencias históricas y solo puede desactivarse/i)).toBeTruthy();
  unmount1();

  // Delete blocked by offline uncertainty
  const { unmount: unmount2 } = render(<CatalogItemManagement organizationId="org" items={[item]} onReload={vi.fn()}
    onDelete={deleteItemBlockedOffline} />);
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación de Yerba' }));
  expect(await screen.findByText(/operaciones offline pendientes y solo puede desactivarse/i)).toBeTruthy();
  unmount2();

  // Structural change blocked by history
  const { unmount: unmount3 } = render(<CatalogItemManagement organizationId="org" items={[item]} onReload={vi.fn()}
    onChangeStructure={changeStructureBlockedHistory} />);
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar estructura de Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Guardar estructura de Yerba' }));
  expect(await screen.findByText(/referencias históricas y no permite cambios estructurales/i)).toBeTruthy();
  unmount3();

  // Structural change blocked by offline uncertainty
  const { unmount: unmount4 } = render(<CatalogItemManagement organizationId="org" items={[item]} onReload={vi.fn()}
    onChangeStructure={changeStructureBlockedOffline} />);
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar estructura de Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Guardar estructura de Yerba' }));
  expect(await screen.findByText(/operaciones offline pendientes bajo la configuración actual/i)).toBeTruthy();
  unmount4();
}, 20000);

