import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { CatalogItemManagement } from '../src/features/catalog/catalog-item-management.js';

afterEach(cleanup);

it('keeps the product list visible and opens creation on demand', async () => {
  render(<CatalogItemManagement organizationId="org" items={[item]} branchName="Centro"
    stocks={[{ branchId: 'branch-a', itemId: item.id, itemName: item.name, baseUnit: 'UNIT', quantity: '2.000', threshold: null, lowStock: false }]}
    onReload={vi.fn()} />);
  const list = screen.getByRole('region', { name: 'Ítems de la organización' });
  const add = screen.getByRole('button', { name: 'Nuevo producto o servicio' });
  expect(screen.queryByRole('textbox', { name: 'Nombre del ítem nuevo' })).toBeNull();
  expect(add.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.click(add);
  expect(screen.getByRole('textbox', { name: 'Nombre del ítem nuevo' })).toBeTruthy();
  const creation = screen.getByRole('heading', { name: 'Ítem nuevo' });
  expect(add.compareDocumentPosition(creation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(creation.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await openProduct('Yerba');
  expect(screen.getByRole('button', { name: 'Editar Yerba' })).toBeTruthy();
  expect(screen.getByText('2 unidades')).toBeTruthy();
});

it('creates an item with a canonical initial price and rejects invalid amounts', async () => {
  const create = vi.fn().mockResolvedValue({ id: 'new-priced-item' });
  render(<CatalogItemManagement organizationId="org" items={[]} onReload={vi.fn()}
    onCreate={create} onLookupSimilar={vi.fn().mockResolvedValue([])} />);
  await userEvent.click(screen.getByRole('button', { name: 'Nuevo producto o servicio' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre del ítem nuevo' }), 'Con precio');
  const price = screen.getByRole('textbox', { name: 'Precio de venta opcional' });
  for (const invalid of ['-1', '1,234', 'abc']) {
    await userEvent.clear(price);
    await userEvent.type(price, invalid);
    await userEvent.click(screen.getByRole('button', { name: 'Crear ítem' }));
    expect(create).not.toHaveBeenCalled();
    expect(price.getAttribute('aria-invalid')).toBe('true');
  }
  await userEvent.clear(price);
  await userEvent.type(price, '1500,50');
  await userEvent.click(screen.getByRole('button', { name: 'Crear ítem' }));
  expect(create).toHaveBeenCalledWith('org', expect.objectContaining({ price: '1500.50' }));
  expect(await screen.findByText('Ítem creado con precio de venta.')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Nuevo producto o servicio' }));
  expect((screen.getByRole('textbox', { name: 'Precio de venta opcional' }) as HTMLInputElement).value).toBe('');
}, 20000);

const item = { id: 'item-a', name: 'Yerba', type: 'PRODUCT' as const, status: 'ACTIVE' as const,
  trackInventory: true, baseUnit: 'UNIT' as const, price: '100.00', priceVersion: 1,
  sku: 'Y-1', barcode: null, version: 2 };

it('optionally groups products by category including uncategorized items and keeps search and ordering', async () => {
  const user = userEvent.setup();
  render(<CatalogItemManagement organizationId="org" items={[
    { ...item, categoryId: 'food' },
    { ...item, id: 'rice', name: 'Arroz', categoryId: 'food', price: '10.00' },
    { ...item, id: 'drink', name: 'Agua', categoryId: 'drink' },
    { ...item, id: 'other', name: 'Bolsa', categoryId: null },
    { ...item, id: 'unknown', name: 'Antiguo', categoryId: 'missing' },
  ]} categories={[
    { id: 'food', name: 'Almacén', status: 'ACTIVE', version: 1 },
    { id: 'drink', name: 'Bebidas', status: 'INACTIVE', version: 1 },
  ]} onReload={vi.fn()} />);
  expect(screen.queryByRole('region', { name: 'Almacén' })).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: 'Agrupar por categorías' }));
  expect(screen.queryByText('Yerba')).toBeNull();
  expect(screen.queryByText('Bolsa')).toBeNull();
  for (const name of ['Almacén', 'Bebidas', 'Sin categoría', 'Categoría no disponible']) {
    const folder = screen.getByRole('button', { name: `Abrir categoría ${name}` });
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    await user.click(folder);
    expect(screen.getByRole('button', { name: `Cerrar categoría ${name}` }).getAttribute('aria-expanded')).toBe('true');
  }
  expect(within(screen.getByRole('region', { name: 'Almacén' })).getByText('Yerba')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Bebidas' })).getByText('Agua')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Sin categoría' })).getByText('Bolsa')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Categoría no disponible' })).getByText('Antiguo')).toBeTruthy();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Ordenar productos' }), 'price-desc');
  expect(Array.from(screen.getByRole('region', { name: 'Almacén' }).querySelectorAll('summary > strong')).map(element => element.textContent)).toEqual(['Yerba', 'Arroz']);
  await user.type(screen.getByRole('searchbox', { name: 'Buscar producto' }), 'agua');
  expect(screen.queryByRole('region', { name: 'Almacén' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Bebidas' })).toBeTruthy();
  await user.click(screen.getByRole('checkbox', { name: 'Agrupar por categorías' }));
  expect(screen.queryByRole('region', { name: 'Bebidas' })).toBeNull();
  expect(screen.getByText('Agua')).toBeTruthy();
  await user.click(screen.getByRole('checkbox', { name: 'Agrupar por categorías' }));
  expect(screen.queryByText('Agua')).toBeNull();
  expect(screen.getByRole('button', { name: 'Abrir categoría Bebidas' })).toBeTruthy();
});

it('orders filtered products by name, exact price and branch stock, keeping unavailable values last', async () => {
  const user = userEvent.setup();
  const items = [
    { ...item, id: 'b', name: 'Bolsa', price: '9007199254740992.01' },
    { ...item, id: 'a', name: 'Árbol', price: '9007199254740992.02' },
    { ...item, id: 'c', name: 'Café', price: null },
  ];
  const stocks = items.slice(0, 2).map(entry => ({ branchId: 'branch', itemId: entry.id, itemName: entry.name,
    baseUnit: 'UNIT' as const, quantity: entry.id === 'a' ? '-1.000' : '10.000',
    threshold: entry.id === 'b' ? '20.000' : null, lowStock: entry.id === 'b' }));
  const props = { organizationId: 'org', items, stocks, branchName: 'Centro', onReload: vi.fn() };
  const { container, rerender } = render(<CatalogItemManagement {...props} />);
  const order = () => Array.from(container.querySelectorAll('summary > strong')).map(element => element.textContent);
  const sort = screen.getByRole('combobox', { name: 'Ordenar productos' });
  expect(order()).toEqual(['Árbol', 'Bolsa', 'Café']);
  for (const [value, expected] of [
    ['name-desc', ['Café', 'Bolsa', 'Árbol']],
    ['price-asc', ['Bolsa', 'Árbol', 'Café']],
    ['price-desc', ['Árbol', 'Bolsa', 'Café']],
    ['stock-asc', ['Árbol', 'Bolsa', 'Café']],
    ['stock-desc', ['Bolsa', 'Árbol', 'Café']],
    ['stock-low', ['Bolsa', 'Árbol', 'Café']],
  ] as const) {
    await user.selectOptions(sort, value);
    expect(order()).toEqual(expected);
  }
  await user.type(screen.getByRole('searchbox', { name: 'Buscar producto' }), 'bolsa');
  expect(order()).toEqual(['Bolsa']);
  await user.click(screen.getByRole('button', { name: 'Limpiar búsqueda' }));
  expect(order()).toEqual(['Bolsa', 'Árbol', 'Café']);
  rerender(<CatalogItemManagement {...props} stockFailed />);
  expect(order()).toEqual(['Árbol', 'Bolsa', 'Café']);
  expect(items.map(entry => entry.name)).toEqual(['Bolsa', 'Árbol', 'Café']);
});

it('filters managed items by name, SKU or barcode and retains editing actions', async () => {
  const user = userEvent.setup();
  const coffee = { ...item, id: 'coffee', name: 'Café molido', sku: 'CAFE-01', barcode: '7791234567890', status: 'INACTIVE' as const };
  render(<CatalogItemManagement organizationId="org" items={[item, coffee]} onReload={vi.fn()} />);
  const list = within(screen.getByRole('region', { name: 'Ítems de la organización' }));
  const search = screen.getByRole('searchbox', { name: 'Buscar producto' });
  await openProduct('Café molido');
  await user.click(list.getByRole('button', { name: 'Editar Café molido' }));
  for (const query of ['  cafe  ', 'cafe-01', '7791234567890']) {
    await user.clear(search);
    await user.type(search, query);
    expect(list.getByRole('button', { name: 'Editar Café molido' })).toBeTruthy();
    expect(list.getByRole('button', { name: 'Activar Café molido' })).toBeTruthy();
    expect(list.queryByRole('button', { name: 'Editar Yerba' })).toBeNull();
    expect(list.getByRole('status').textContent).toBe('1 de 2 ítems');
  }
  expect(list.getByRole('textbox', { name: 'Nombre de Café molido' })).toBeTruthy();
  await user.clear(search);
  await user.type(search, 'inexistente');
  expect(list.getByText('No encontramos ítems con esa búsqueda. Probá con otro nombre, SKU o código de barras.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Limpiar búsqueda' }));
  expect(document.activeElement).toBe(search);
  await openProduct('Yerba');
  expect(list.getByRole('button', { name: 'Editar Yerba' })).toBeTruthy();
}, 15000);

it('assigns, changes and removes the optional catalog category', async () => {
  const categories = [
    { id: 'category-a', name: 'Almacén', status: 'ACTIVE' as const, version: 1 },
    { id: 'category-b', name: 'Bebidas', status: 'ACTIVE' as const, version: 1 },
    { id: 'category-old', name: 'Anterior', status: 'INACTIVE' as const, version: 1 },
  ];
  const create = vi.fn().mockResolvedValue(item);
  const edit = vi.fn().mockResolvedValue(item);
  const props = { organizationId: 'org', items: [{ ...item, categoryId: 'category-a' }], categories,
    onReload: vi.fn(), onCreate: create, onEdit: edit, onLookupSimilar: vi.fn().mockResolvedValue([]) };
  const { rerender } = render(<CatalogItemManagement {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Nuevo producto o servicio' }));
  const newCategory = screen.getByRole('combobox', { name: 'Categoría del ítem nuevo' });
  expect((newCategory as HTMLSelectElement).value).toBe('');
  expect(within(newCategory).queryByRole('option', { name: 'Anterior' })).toBeNull();
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre del ítem nuevo' }), 'Nuevo');
  await userEvent.selectOptions(newCategory, 'category-b');
  await userEvent.click(screen.getByRole('button', { name: 'Crear ítem' }));
  expect(create).toHaveBeenCalledWith('org', expect.objectContaining({ categoryId: 'category-b' }));
  await openProduct('Yerba');
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  expect((screen.getByRole('combobox', { name: 'Categoría de Yerba' }) as HTMLSelectElement).value).toBe('category-a');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Categoría de Yerba' }), 'category-b');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios de Yerba' }));
  expect(edit).toHaveBeenLastCalledWith('org', item.id, 2, expect.objectContaining({ categoryId: 'category-b' }));
  rerender(<CatalogItemManagement {...props} items={[{ ...item, categoryId: 'category-b', version: 3 }]} />);
  await openProduct('Yerba');
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  expect((screen.getByRole('combobox', { name: 'Categoría de Yerba' }) as HTMLSelectElement).value).toBe('category-b');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Categoría de Yerba' }), '');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios de Yerba' }));
  expect(edit).toHaveBeenLastCalledWith('org', item.id, 3, expect.objectContaining({ categoryId: null }));
  rerender(<CatalogItemManagement {...props} items={[{ ...item, categoryId: 'category-old', version: 4 }]} />);
  await openProduct('Yerba');
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  expect((screen.getByRole('combobox', { name: 'Categoría de Yerba' }) as HTMLSelectElement).value).toBe('category-old');
  expect(screen.getByRole('option', { name: 'Anterior (inactiva)' })).toBeTruthy();
}, 15000);

it('distinguishes an empty managed catalog from a search without matches', async () => {
  render(<CatalogItemManagement organizationId="org" items={[]} onReload={vi.fn()} />);
  await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar producto' }), 'yerba');
  expect(screen.getByText('No hay ítems registrados.')).toBeTruthy();
});

it('creates products with nonstructural fields, warns on names, and edits price separately', async () => {
  const create = vi.fn().mockResolvedValue(item);
  const edit = vi.fn().mockResolvedValue({ id: item.id, name: 'Yerba nueva', sku: 'Y-2', barcode: null, version: 3 });
  const price = vi.fn().mockResolvedValue({ itemId: item.id, price: '150.00', priceVersion: 2, version: 3, currency: 'ARS' });
  const lookup = vi.fn().mockResolvedValue(['Yerba']);
  const { container } = render(<CatalogItemManagement organizationId="org" items={[item]} onReload={vi.fn()}
    onCreate={create} onEdit={edit} onPrice={price} onLookupSimilar={lookup} />);
  await userEvent.click(screen.getByRole('button', { name: 'Nuevo producto o servicio' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre del ítem nuevo' }), 'Yerba extra');
  await userEvent.tab();
  expect(await screen.findByText('Posibles duplicados detectados:')).toBeTruthy();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Controlar inventario' }));
  await userEvent.click(screen.getByRole('button', { name: 'Crear ítem' }));
  expect(create).toHaveBeenCalledWith('org', expect.objectContaining({ name: 'Yerba extra', type: 'PRODUCT', trackInventory: true }));
  await openProduct('Yerba');
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  await userEvent.clear(screen.getByRole('textbox', { name: 'Nombre de Yerba' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de Yerba' }), 'Yerba nueva');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios de Yerba' }));
  expect(edit).toHaveBeenCalledWith('org', 'item-a', 2, expect.objectContaining({ name: 'Yerba nueva' }));
  if (screen.getByRole('button', { name: 'Editar Yerba' }).getAttribute('aria-expanded') !== 'true') await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
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
  await openProduct('Yerba');
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
  await openProduct('Yerba');
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));

  // Status toggle
  await userEvent.click(screen.getByRole('button', { name: 'Desactivar Yerba' }));
  expect(changeStatus).toHaveBeenCalledWith('org', 'item-a', 2, 'INACTIVE');

  // Deletion flow with confirmation
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar Yerba' }));
  expect(screen.getByText('¿Confirmás eliminar definitivamente Yerba?')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación de Yerba' }));
  expect(deleteItem).toHaveBeenCalledWith('org', 'item-a', 2);

  // Structural change
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
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
  await openProduct('Yerba');
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación de Yerba' }));
  expect(await screen.findByText(/referencias históricas y solo puede desactivarse/i)).toBeTruthy();
  unmount1();

  // Delete blocked by offline uncertainty
  const { unmount: unmount2 } = render(<CatalogItemManagement organizationId="org" items={[item]} onReload={vi.fn()}
    onDelete={deleteItemBlockedOffline} />);
  await openProduct('Yerba');
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación de Yerba' }));
  expect(await screen.findByText(/operaciones offline pendientes y solo puede desactivarse/i)).toBeTruthy();
  unmount2();

  // Structural change blocked by history
  const { unmount: unmount3 } = render(<CatalogItemManagement organizationId="org" items={[item]} onReload={vi.fn()}
    onChangeStructure={changeStructureBlockedHistory} />);
  await openProduct('Yerba');
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar estructura de Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Guardar estructura de Yerba' }));
  expect(await screen.findByText(/referencias históricas y no permite cambios estructurales/i)).toBeTruthy();
  unmount3();

  // Structural change blocked by offline uncertainty
  const { unmount: unmount4 } = render(<CatalogItemManagement organizationId="org" items={[item]} onReload={vi.fn()}
    onChangeStructure={changeStructureBlockedOffline} />);
  await openProduct('Yerba');
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar estructura de Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Guardar estructura de Yerba' }));
  expect(await screen.findByText(/operaciones offline pendientes bajo la configuración actual/i)).toBeTruthy();
  unmount4();
}, 20000);


it('reveals product details and stock controls only after selecting the product', async () => {
  render(<CatalogItemManagement organizationId="org" items={[item]} branchName="Centro"
    stocks={[{ branchId: 'branch-a', itemId: item.id, itemName: item.name, baseUnit: 'UNIT', quantity: '2.000', threshold: null, lowStock: false }]}
    onReload={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Editar Yerba' })).toBeNull();
  expect(screen.getByText('Precio: 100.00')).toBeTruthy();
  expect(screen.getByText('2 unidades')).toBeTruthy();
  await userEvent.click(screen.getByText('Yerba', { exact: true }));
  await openProduct('Yerba');
  expect(screen.getByRole('button', { name: 'Editar Yerba' })).toBeTruthy();
  await userEvent.click(screen.getByText('Cambiar stock de Yerba'));
  expect(screen.getByRole('button', { name: 'Confirmar ajuste' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Mínimo de Yerba' })).toBeTruthy();
});

async function openProduct(name: string) {
  const label = screen.getByText(name, { exact: true, selector: 'summary > strong' });
  if (!label.closest('details')?.open) await userEvent.click(label);
}

it('keeps price, structure, status and deletion inside product editing', async () => {
  render(<CatalogItemManagement organizationId="org" items={[item]} onReload={vi.fn()} />);
  await openProduct('Yerba');
  for (const name of ['Cambiar precio de Yerba', 'Cambiar estructura de Yerba', 'Desactivar Yerba', 'Eliminar Yerba']) {
    expect(screen.queryByRole('button', { name })).toBeNull();
  }
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  for (const name of ['Cambiar precio de Yerba', 'Cambiar estructura de Yerba', 'Desactivar Yerba', 'Eliminar Yerba']) {
    expect(screen.getByRole('button', { name })).toBeTruthy();
  }
  if (screen.getByRole('button', { name: 'Editar Yerba' }).getAttribute('aria-expanded') !== 'true') await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar precio de Yerba' }));
  expect(screen.getByRole('textbox', { name: 'Precio nuevo de Yerba' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Editar Yerba' }));
  expect(screen.queryByRole('textbox', { name: 'Precio nuevo de Yerba' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Eliminar Yerba' })).toBeNull();
});
