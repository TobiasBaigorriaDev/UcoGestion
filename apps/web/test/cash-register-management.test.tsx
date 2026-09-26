import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { CashRegisterManagement, type ManagedCashRegister } from '../src/features/cash/cash-register-management.js';

afterEach(cleanup);

const branches = [
  { id: 'branch-1', name: 'Sucursal Central' },
  { id: 'branch-2', name: 'Sucursal Tupungato' },
];

const registerA: ManagedCashRegister = {
  id: 'reg-1',
  branchId: 'branch-1',
  name: 'Caja Mostrador 1',
  status: 'ACTIVE',
  version: 1,
};

const registerB: ManagedCashRegister = {
  id: 'reg-2',
  branchId: 'branch-1',
  name: 'Caja Depósito',
  status: 'INACTIVE',
  version: 2,
};

it('allows OWNER/ADMIN to create, rename, and deactivate cash registers with accessible confirmation within branch scope', async () => {
  const create = vi.fn().mockResolvedValue({ ...registerA, id: 'reg-new', name: 'Caja Nueva' });
  const rename = vi.fn().mockResolvedValue({ ...registerA, name: 'Caja Mostrador Principal', version: 2 });
  const deactivate = vi.fn().mockResolvedValue({ ...registerA, status: 'INACTIVE', version: 2 });
  const reload = vi.fn();

  const { container } = render(
    <CashRegisterManagement
      organizationId="org"
      role="OWNER"
      branches={branches}
      selectedBranchId="branch-1"
      cashRegisters={[registerA, registerB]}
      onReload={reload}
      onCreate={create}
      onRename={rename}
      onDeactivate={deactivate}
    />,
  );

  expect(screen.getByRole('heading', { name: 'Cajas de la sucursal' })).toBeTruthy();
  expect(screen.getByText('Caja Mostrador 1')).toBeTruthy();
  expect(screen.getByText('Caja Depósito')).toBeTruthy();

  // Create
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de la caja nueva' }), 'Caja Nueva');
  await userEvent.click(screen.getByRole('button', { name: 'Crear caja' }));
  expect(create).toHaveBeenCalledWith('org', 'branch-1', 'Caja Nueva');

  // Rename
  await userEvent.click(screen.getByRole('button', { name: 'Renombrar Caja Mostrador 1' }));
  await userEvent.clear(screen.getByRole('textbox', { name: 'Nombre nuevo de Caja Mostrador 1' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre nuevo de Caja Mostrador 1' }), 'Caja Mostrador Principal');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar nombre de Caja Mostrador 1' }));
  expect(rename).toHaveBeenCalledWith('org', 'branch-1', 'reg-1', 1, 'Caja Mostrador Principal');

  // Deactivate with confirmation
  await userEvent.click(screen.getByRole('button', { name: 'Desactivar Caja Mostrador 1' }));
  expect(screen.getByText(/¿Confirmás desactivar la caja Caja Mostrador 1\?/i)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar desactivación de Caja Mostrador 1' }));
  expect(deactivate).toHaveBeenCalledWith('org', 'branch-1', 'reg-1', 1);

  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
}, 20000);

it('renders read-only view for CASHIER without mutation controls', async () => {
  render(
    <CashRegisterManagement
      organizationId="org"
      role="CASHIER"
      branches={branches}
      selectedBranchId="branch-1"
      cashRegisters={[registerA]}
      onReload={vi.fn()}
    />,
  );

  expect(screen.queryByRole('button', { name: 'Crear caja' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Renombrar Caja Mostrador 1' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Desactivar Caja Mostrador 1' })).toBeNull();
});

it('handles name conflict error with accessible message', async () => {
  const createConflict = vi.fn().mockRejectedValue({
    status: 409,
    code: 'CASH_REGISTER_NAME_CONFLICT',
    message: 'Ya existe una caja con ese nombre en la sucursal.',
  });

  render(
    <CashRegisterManagement
      organizationId="org"
      role="ADMIN"
      branches={branches}
      selectedBranchId="branch-1"
      cashRegisters={[]}
      onReload={vi.fn()}
      onCreate={createConflict}
    />,
  );

  await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de la caja nueva' }), 'Caja Duplicada');
  await userEvent.click(screen.getByRole('button', { name: 'Crear caja' }));
  expect(await screen.findByText(/Ya existe una caja con ese nombre en la sucursal/i)).toBeTruthy();
}, 15000);
