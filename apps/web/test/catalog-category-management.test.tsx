import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { CatalogCategoryManagement } from '../src/features/catalog/catalog-category-management.js';
import { ApiProblemError } from '../src/lib/api/client.js';

afterEach(cleanup);

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
