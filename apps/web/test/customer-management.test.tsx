import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { CustomerManagement, type ManagedCustomer } from '../src/features/customers/customer-management.js';

afterEach(cleanup);

const customerA: ManagedCustomer = {
  id: 'cust-1',
  name: 'Acme Corp',
  taxId: '30-71123456-7',
  contact: 'Juan Pérez (juan@acme.com)',
  address: 'Av. San Martín 123',
  notes: 'Cliente mayorista',
  status: 'ACTIVE',
  version: 1,
  createdAt: '2026-09-20T10:00:00Z',
  updatedAt: '2026-09-20T10:00:00Z',
};

const customerB: ManagedCustomer = {
  id: 'cust-2',
  name: 'Bodega La Consulta',
  taxId: null,
  contact: null,
  address: null,
  notes: null,
  status: 'INACTIVE',
  version: 2,
  createdAt: '2026-09-21T10:00:00Z',
  updatedAt: '2026-09-21T12:00:00Z',
};

it('allows OWNER/ADMIN to create, edit, toggle status and delete customer with accessible confirmation', async () => {
  const create = vi.fn().mockResolvedValue({ ...customerA, id: 'cust-new' });
  const edit = vi.fn().mockResolvedValue({ ...customerA, name: 'Acme Corp Renovada', version: 2 });
  const changeStatus = vi.fn().mockResolvedValue({ ...customerA, status: 'INACTIVE', version: 2 });
  const remove = vi.fn().mockResolvedValue({ id: customerA.id, deleted: true });
  const reload = vi.fn();

  const { container } = render(
    <CustomerManagement
      organizationId="org"
      role="OWNER"
      customers={[customerA, customerB]}
      onReload={reload}
      onCreate={create}
      onEdit={edit}
      onChangeStatus={changeStatus}
      onDelete={remove}
    />,
  );

  // Accessible landmarks and structure
  expect(screen.getByRole('heading', { name: 'Clientes' })).toBeTruthy();
  expect(screen.getByText('Acme Corp')).toBeTruthy();
  expect(screen.getByText('Bodega La Consulta')).toBeTruthy();

  // Create
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre del cliente nuevo' }), 'Nuevo Cliente');
  await userEvent.type(screen.getByRole('textbox', { name: 'CUIT/Identificación tributaria opcional' }), '20-12345678-9');
  await userEvent.click(screen.getByRole('button', { name: 'Crear cliente' }));
  expect(create).toHaveBeenCalledWith('org', expect.objectContaining({ name: 'Nuevo Cliente', taxId: '20-12345678-9' }));

  // Edit
  await userEvent.click(screen.getByRole('button', { name: 'Editar Acme Corp' }));
  await userEvent.clear(screen.getByRole('textbox', { name: 'Nombre de Acme Corp' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de Acme Corp' }), 'Acme Corp Renovada');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios de Acme Corp' }));
  expect(edit).toHaveBeenCalledWith('org', customerA.id, 1, expect.objectContaining({ name: 'Acme Corp Renovada' }));

  // Toggle status
  await userEvent.click(screen.getByRole('button', { name: 'Desactivar Acme Corp' }));
  expect(changeStatus).toHaveBeenCalledWith('org', customerA.id, 1, 'INACTIVE');

  // Delete flow with confirmation
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar Acme Corp' }));
  expect(screen.getByText('¿Confirmás eliminar definitivamente Acme Corp?')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación de Acme Corp' }));
  expect(remove).toHaveBeenCalledWith('org', customerA.id, 1);

  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
}, 20000);

it('allows CASHIER to create and edit allowed fields, but forbids status change and deletion', async () => {
  render(
    <CustomerManagement
      organizationId="org"
      role="CASHIER"
      customers={[customerA]}
      onReload={vi.fn()}
      onCreate={vi.fn()}
      onEdit={vi.fn()}
    />,
  );

  // Can create and edit
  expect(screen.getByRole('button', { name: 'Crear cliente' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Editar Acme Corp' })).toBeTruthy();

  // Status and delete buttons must NOT be present
  expect(screen.queryByRole('button', { name: 'Desactivar Acme Corp' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Eliminar Acme Corp' })).toBeNull();
});

it('renders read-only view for EMPLOYEE without mutation controls', async () => {
  render(
    <CustomerManagement
      organizationId="org"
      role="EMPLOYEE"
      customers={[customerA]}
      onReload={vi.fn()}
    />,
  );

  expect(screen.queryByRole('button', { name: 'Crear cliente' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Editar Acme Corp' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Desactivar Acme Corp' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Eliminar Acme Corp' })).toBeNull();
});

it('displays clear D01 message when deletion is blocked by history', async () => {
  const removeBlocked = vi.fn().mockRejectedValue({
    status: 409,
    code: 'CUSTOMER_DELETE_BLOCKED_BY_HISTORY',
    message: 'El cliente posee referencias históricas y solo puede desactivarse.',
  });

  render(
    <CustomerManagement
      organizationId="org"
      role="ADMIN"
      customers={[customerA]}
      onReload={vi.fn()}
      onDelete={removeBlocked}
    />,
  );

  await userEvent.click(screen.getByRole('button', { name: 'Eliminar Acme Corp' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar eliminación de Acme Corp' }));
  expect(await screen.findByText(/referencias históricas y solo puede desactivarse/i)).toBeTruthy();
}, 15000);
