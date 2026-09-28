import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { ExpenseWorkspace } from '../src/features/expenses/expense-workspace.js';
import { ApiProblemError } from '../src/lib/api/client.js';

afterEach(cleanup);
const id = '11111111-1111-4111-8111-111111111111';
const props = { organizationId: 'org', branchId: 'branch',
  categories: [{ id: 'cat', name: 'Servicios' }],
  paymentMethods: ['CASH', 'TRANSFER'], sessions: [{ id: 'session', deviceId: 'device', registerName: 'Caja' }],
  onCreate: vi.fn().mockResolvedValue({ id, branchId: 'branch', categoryId: 'cat', concept: 'Luz',
    amount: '2.00', method: 'CASH', currency: 'ARS', actorUserId: 'user', occurredAt: '2026-09-27T00:00:00Z' }),
  onLoad: vi.fn(), onCancel: vi.fn() };

it('T173B limits cashier to cash, active category and own session', async () => {
  const create = vi.fn().mockResolvedValue({ id, branchId: 'branch', categoryId: 'cat', concept: 'Luz',
    amount: '2.00', method: 'CASH', currency: 'ARS', actorUserId: 'user', occurredAt: '2026-09-27T00:00:00Z' });
  const { container } = render(<ExpenseWorkspace {...props} role="CASHIER" onCreate={create} />);
  expect(screen.queryByRole('option', { name: 'TRANSFER' })).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText('Categoría de gasto'), 'cat');
  await userEvent.type(screen.getByLabelText('Concepto'), 'Luz');
  await userEvent.type(screen.getByLabelText('Importe'), '2.00');
  await userEvent.selectOptions(screen.getByLabelText('Sesión de caja'), 'session');
  await userEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
  expect(create).toHaveBeenCalledWith('org', { branchId: 'branch', categoryId: 'cat', concept: 'Luz',
    amount: '2.00', method: 'CASH', cashSessionId: 'session', deviceId: 'device' }, expect.any(String));
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

it('T173B shows actionable cash error without clearing the form', async () => {
  const create = vi.fn().mockRejectedValue(new ApiProblemError({ status: 409,
    code: 'CASH_INSUFFICIENT_EXPECTED', message: 'Registrá un ingreso o usá otra sesión válida.' }));
  render(<ExpenseWorkspace {...props} role="OWNER" onCreate={create} />);
  await userEvent.selectOptions(screen.getByLabelText('Categoría de gasto'), 'cat');
  await userEvent.type(screen.getByLabelText('Concepto'), 'Luz');
  await userEvent.type(screen.getByLabelText('Importe'), '2.00');
  await userEvent.selectOptions(screen.getByLabelText('Medio de pago'), 'CASH');
  await userEvent.selectOptions(screen.getByLabelText('Sesión de caja'), 'session');
  await userEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
  expect(await screen.findByText(/Registrá un ingreso/i)).toBeTruthy();
  expect((screen.getByLabelText('Importe') as HTMLInputElement).value).toBe('2.00');
});

it('T173B cancels cash expense using a valid session and hides repeat cancellation', async () => {
  const detail = { id, branchId: 'branch', categoryId: 'cat', concept: 'Luz', amount: '2.00',
    method: 'CASH', currency: 'ARS', actorUserId: 'user', occurredAt: '2026-09-27T00:00:00Z',
    status: 'CONFIRMED' as const, cancellation: null };
  const load = vi.fn().mockResolvedValueOnce(detail).mockResolvedValueOnce({ ...detail,
    status: 'CANCELLED', cancellation: { reason: 'Error', cancelledAt: '2026-09-27T01:00:00Z' } });
  const cancel = vi.fn().mockResolvedValue({ id: 'cancel', expenseId: id, status: 'CANCELLED' });
  render(<ExpenseWorkspace {...props} role="ADMIN" onLoad={load} onCancel={cancel} />);
  await userEvent.type(screen.getByLabelText('ID de gasto'), id);
  await userEvent.click(screen.getByRole('button', { name: 'Consultar gasto' }));
  await userEvent.type(await screen.findByLabelText('Motivo de anulación'), 'Error');
  await userEvent.selectOptions(screen.getByLabelText('Sesión para devolver efectivo'), 'session');
  await userEvent.click(screen.getByRole('button', { name: 'Anular gasto' }));
  expect(cancel).toHaveBeenCalledWith('org', id, { reason: 'Error', cashSessionId: 'session',
    deviceId: 'device' }, expect.any(String));
  expect(await screen.findByText('Anulado')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Anular gasto' })).toBeNull();
});
