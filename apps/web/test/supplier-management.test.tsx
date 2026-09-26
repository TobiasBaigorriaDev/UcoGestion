import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { SupplierManagement, type ManagedSupplier } from '../src/features/suppliers/supplier-management.js';

afterEach(cleanup);

const supplierA: ManagedSupplier = {
  id: 'sup-1',
  name: 'Distribuidora Cuyo',
  taxId: '30-98765432-1',
  contact: 'Carlos Gómez (carlos@cuyo.com)',
  address: 'Ruta 40 Km 80',
  notes: 'Proveedor principal de bebidas',
  status: 'ACTIVE',
  version: 1,
  createdAt: '2026-09-20T10:00:00Z',
  updatedAt: '2026-09-20T10:00:00Z',
};

const supplierB: ManagedSupplier = {
  id: 'sup-2',
  name: 'Empaques del Valle',
  taxId: null,
  contact: null,
  address: null,
  notes: null,
  status: 'INACTIVE',
  version: 2,
  createdAt: '2026-09-21T10:00:00Z',
  updatedAt: '2026-09-21T12:00:00Z',
};

it('allows OWNER/ADMIN to create, edit, toggle status and delete supplier with accessible confirmation', async () => {
  const create = vi.fn().mockResolvedValue({ ...supplierA, id: 'sup-new' });
  const edit = vi.fn().mockResolvedValue({ ...supplierA, name: 'Distribuidora Cuyo S.A.', version: 2 });
  const changeStatus = vi.fn().mockResolvedValue({ ...supplierA, status: 'INACTIVE', version: 2 });
  const remove = vi.fn().mockResolvedValue({ id: supplierA.id, deleted: true });
  const reload = vi.fn();

  const { container } = render(
    <SupplierManagement
      organizationId="org"
      role="OWNER"
      suppliers={[supplierA, supplierB]}
      onReload={reload}
      onCreate={create}
      onEdit={edit}
      onChangeStatus={changeStatus}
      onDelete={remove}
    />,
  );

  // Accessible landmarks and structure
  expect(screen.getByRole('heading', { name: 'Proveedores' })).toBeTruthy();
  expect(screen.getByText('Distribuidora Cuyo')).toBeTruthy();
  expect(screen.getByText('Empaques del Valle')).toBeTruthy();

  // Create
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre del proveedor nuevo' }), 'Nuevo Proveedor');
  await userEvent.type(screen.getByRole('textbox', { name: 'CUIT/Identificación tributaria opcional' }), '30-55555555-5');
  await userEvent.click(screen.getByRole('button', { name: 'Crear proveedor' }));
  expect(create).toHaveBeenCalledWith('org', expect.objectContaining({ name: 'Nuevo Proveedor', taxId: '30-55555555-5' }));

  // Edit
  await userEvent.click(screen.getByRole('button', { name: 'Editar Distribuidora Cuyo' }));
  await userEvent.clear(screen.getByRole('textbox', { name: 'Nombre de Distribuidora Cuyo' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de Distribuidora Cuyo' }), 'Distribuidora Cuyo S.A.');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios de Distribuidora Cuyo' }));
  expect(edit).toHaveBeenCalledWith('org', supplierA.id, 1, expect.objectContaining({ name: 'Distribuidora Cuyo S.A.' }));

  // Toggle status
  await userEvent.click(screen.getByRole('button', { name: 'Desactivar Distribuidora Cuyo' }));
  expect(changeStatus).toHaveBeenCalledWith('org', supplierA.id, 1, 'INACTIVE');

  // Delete flow with confirmation
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar Distribuidora Cuyo' }));
  expect(screen.getByText('¿Confirmás eliminar definitivamente Distribuidora Cuyo?')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación de Distribuidora Cuyo' }));
  expect(remove).toHaveBeenCalledWith('org', supplierA.id, 1);

  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
}, 20000);

it('renders read-only view for CASHIER and EMPLOYEE without administrative mutation controls', async () => {
  render(
    <SupplierManagement
      organizationId="org"
      role="CASHIER"
      suppliers={[supplierA]}
      onReload={vi.fn()}
    />,
  );

  expect(screen.queryByRole('button', { name: 'Crear proveedor' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Editar Distribuidora Cuyo' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Desactivar Distribuidora Cuyo' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Eliminar Distribuidora Cuyo' })).toBeNull();
});

it('displays clear D01 message when deletion is blocked by history', async () => {
  const removeBlocked = vi.fn().mockRejectedValue({
    status: 409,
    code: 'SUPPLIER_DELETE_BLOCKED_BY_HISTORY',
    message: 'El proveedor posee compras o movimientos históricos y solo puede desactivarse.',
  });

  render(
    <SupplierManagement
      organizationId="org"
      role="ADMIN"
      suppliers={[supplierA]}
      onReload={vi.fn()}
      onDelete={removeBlocked}
    />,
  );

  await userEvent.click(screen.getByRole('button', { name: 'Eliminar Distribuidora Cuyo' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación de Distribuidora Cuyo' }));
  expect(await screen.findByText(/referencias históricas y solo puede desactivarse/i)).toBeTruthy();
}, 15000);
