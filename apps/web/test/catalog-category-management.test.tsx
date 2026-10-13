import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { CatalogCategoryManagement } from '../src/features/catalog/catalog-category-management.js';
import { ApiProblemError } from '../src/lib/api/client.js';

afterEach(cleanup);

it('shows only icon artwork and offers searchable grocery and kiosk choices', async () => {
  const user = userEvent.setup();
  const create = vi.fn().mockResolvedValue({ id: 'soda', name: 'Bebidas', icon: 'cup-soda', status: 'ACTIVE', version: 1 });
  render(<CatalogCategoryManagement organizationId="org" categories={[]} onCreate={create} onReload={vi.fn()} />);
  expect(screen.queryByText(/^Icono:/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Elegir icono' }));
  expect(screen.queryByText('Carpeta general')).toBeNull();
  expect(screen.queryByText('Golosinas')).toBeNull();
  expect(screen.getAllByRole('radio')).toHaveLength(52);
  for (const name of ['Gaseosas y refrescos', 'Helados', 'Galletitas', 'Limpieza', 'Cigarrillos', 'Pilas']) {
    expect(screen.getByRole('radio', { name })).toBeTruthy();
    expect(screen.queryByText(name)).toBeNull();
  }
  await user.type(screen.getByRole('searchbox', { name: 'Buscar icono' }), 'gaseosas');
  await user.click(screen.getByRole('radio', { name: 'Gaseosas y refrescos' }));
  await user.type(screen.getByRole('textbox', { name: 'Nombre de la categoría' }), 'Bebidas');
  await user.click(screen.getByRole('button', { name: 'Crear categoría' }));
  expect(create).toHaveBeenCalledWith('org', 'Bebidas', 'cup-soda');
});

it('selects a library icon on creation and allows replacing it on edit', async () => {
  const user = userEvent.setup();
  const create = vi.fn().mockResolvedValue({ id: 'coffee', name: 'Café', icon: 'coffee', status: 'ACTIVE', version: 1 });
  const update = vi.fn().mockResolvedValue({ id: 'coffee', name: 'Café', icon: 'apple', status: 'ACTIVE', version: 2 });
  render(<CatalogCategoryManagement organizationId="org" categories={[{ id: 'coffee', name: 'Café', icon: 'coffee', status: 'ACTIVE', version: 1 }]}
    onCreate={create} onUpdate={update} onReload={vi.fn()} />);
  await user.type(screen.getByRole('textbox', { name: 'Nombre de la categoría' }), 'Café');
  await user.click(screen.getByRole('button', { name: 'Elegir icono' }));
  await user.type(screen.getByRole('searchbox', { name: 'Buscar icono' }), 'cafe');
  await user.click(screen.getByRole('radio', { name: 'Café y bebidas calientes' }));
  await user.click(screen.getByRole('button', { name: 'Crear categoría' }));
  expect(create).toHaveBeenCalledWith('org', 'Café', 'coffee');
  await user.click(screen.getByRole('button', { name: 'Editar Café' }));
  await user.click(screen.getByRole('button', { name: 'Cambiar icono de Café' }));
  await user.click(screen.getByRole('radio', { name: 'Frutas' }));
  await user.click(screen.getByRole('button', { name: 'Guardar nombre de Café' }));
  expect(update).toHaveBeenCalledWith('org', 'coffee', 1, 'Café', 'apple');
});

it('T236I: edits the selected category using its version and reloads after success', async () => {
  const update = vi.fn().mockResolvedValue({ id: 'active-id', name: 'Bebidas', status: 'ACTIVE', version: 2 });
  const reload = vi.fn();
  render(<CatalogCategoryManagement organizationId="org" categories={categories} onUpdate={update} onReload={reload} />);
  await userEvent.click(screen.getByRole('button', { name: 'Editar Almacén' }));
  const input = screen.getByRole('textbox', { name: 'Nuevo nombre de Almacén' });
  await userEvent.clear(input);
  await userEvent.type(input, 'Bebidas');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar nombre de Almacén' }));
  expect(update).toHaveBeenCalledWith('org', 'active-id', 1, 'Bebidas');
  expect(reload).toHaveBeenCalledOnce();
  expect((await screen.findByRole('status')).textContent).toBe('Categoría actualizada.');
});

const categories = [
  { id: 'active-id', name: 'Almacén', status: 'ACTIVE' as const, version: 1 },
  { id: 'inactive-id', name: 'Antigua', status: 'INACTIVE' as const, version: 3 },
];

it('lets an administrator create, activate, and explicitly confirm deletion', async () => {
  const create = vi.fn().mockResolvedValue({ ...categories[0], id: 'new-id', name: 'Bebidas' });
  const changeStatus = vi.fn().mockResolvedValue({ ...categories[1], status: 'ACTIVE', version: 4 });
  const remove = vi.fn().mockResolvedValue({ id: 'active-id', deleted: true });
  const reload = vi.fn();
  const { container } = render(<CatalogCategoryManagement organizationId="org" categories={categories}
    onCreate={create} onChangeStatus={changeStatus} onDelete={remove} onReload={reload} />);
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de la categoría' }), 'Bebidas');
  await userEvent.click(screen.getByRole('button', { name: 'Crear categoría' }));
  expect(create).toHaveBeenCalledWith('org', 'Bebidas');
  await userEvent.click(screen.getByRole('button', { name: 'Activar Antigua' }));
  expect(changeStatus).toHaveBeenCalledWith('org', 'inactive-id', 3, 'ACTIVE');
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar Almacén' }));
  expect(remove).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación de Almacén' }));
  expect(remove).toHaveBeenCalledWith('org', 'active-id', 1);
  expect(reload).toHaveBeenCalled();
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

it('explains an offline exposure block and offers deactivation', async () => {
  const remove = vi.fn().mockRejectedValue(new ApiProblemError({ status: 409,
    code: 'CATEGORY_DELETE_BLOCKED_BY_OFFLINE_EXPOSURE', message: 'Blocked' }));
  render(<CatalogCategoryManagement organizationId="org" categories={categories}
    onCreate={vi.fn()} onChangeStatus={vi.fn()} onDelete={remove} onReload={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar Almacén' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación de Almacén' }));
  expect(await screen.findByText(/Sincronizá los dispositivos y confirmá el checkpoint/)).toBeTruthy();
});
