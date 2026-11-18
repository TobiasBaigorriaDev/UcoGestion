import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExpenseWorkspace } from '../src/features/expenses/expense-workspace.js';

afterEach(cleanup);
const id = '11111111-1111-4111-8111-111111111111';
const row = { id, branchId: 'branch', categoryId: 'cat', categoryName: 'Servicios', actorUserId: 'user', concept: 'Luz',
  amount: '12500.00', method: 'TRANSFER', currencyCode: 'ARS', status: 'CONFIRMED', occurredAt: '2026-10-09T12:00:00Z' };
const detail = { id, branchId: 'branch', categoryId: 'cat', concept: 'Luz', amount: '12500.00', method: 'TRANSFER', currency: 'ARS',
  actorUserId: 'user', occurredAt: '2026-10-09T12:00:00Z', status: 'CONFIRMED' as const, cancellation: null };
const props = { organizationId: 'org', branchId: 'branch', categories: [{ id: 'cat', name: 'Servicios' }],
  paymentMethods: ['CASH', 'TRANSFER'], sessions: [{ id: 'session', deviceId: 'device', registerName: 'Caja' }],
  onCreate: vi.fn(), onCancel: vi.fn() };

describe('D08 expense history', () => {
  it('lists the branch expenses for owners and opens one without typing an ID', async () => {
    const loadHistory = vi.fn().mockResolvedValue({ dataset: 'expenses', items: [row], nextCursor: null, net: '12500.00' });
    const onLoad = vi.fn().mockResolvedValue(detail);
    const { container } = render(<ExpenseWorkspace {...props} role="OWNER" onLoad={onLoad} loadHistory={loadHistory} />);
    const history = await screen.findByRole('region', { name: 'Historial de gastos' });
    expect(loadHistory).toHaveBeenCalledWith('org', { branchId: 'branch' });
    const item = await within(history).findByRole('button', { name: /Luz/ });
    expect(item.textContent).toContain('Servicios');
    expect(item.textContent).toContain('$ 12.500,00');
    expect(item.textContent).toContain('Transferencia');
    expect(within(history).getByText('Total del período').nextElementSibling?.textContent).toBe('$ 12.500,00');
    await userEvent.click(item);
    expect(onLoad).toHaveBeenCalledWith('org', id);
    const shown = await screen.findByRole('region', { name: 'Detalle de gasto' });
    expect(within(shown).getByText('$ 12.500,00')).toBeDefined();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('filters by status and loads more pages with the cursor', async () => {
    const loadHistory = vi.fn()
      .mockResolvedValueOnce({ dataset: 'expenses', items: [row], nextCursor: 'next', net: '12500.00' })
      .mockResolvedValueOnce({ dataset: 'expenses', items: [{ ...row, id: '22222222-2222-4222-8222-222222222222', concept: 'Agua' }], nextCursor: null, net: '12500.00' })
      .mockResolvedValue({ dataset: 'expenses', items: [], nextCursor: null, net: '0.00' });
    render(<ExpenseWorkspace {...props} role="ADMIN" onLoad={vi.fn()} loadHistory={loadHistory} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ver más gastos' }));
    expect(await screen.findByRole('button', { name: /Agua/ })).toBeDefined();
    expect(loadHistory).toHaveBeenLastCalledWith('org', { branchId: 'branch', cursor: 'next' });
    await userEvent.selectOptions(screen.getByLabelText('Estado del gasto'), 'CANCELLED');
    await waitFor(() => expect(loadHistory).toHaveBeenLastCalledWith('org', { branchId: 'branch', status: 'CANCELLED' }));
    expect(await screen.findByText('No hay gastos con estos filtros.')).toBeDefined();
  });

  it('keeps cashiers on registering expenses, without the branch history', () => {
    const loadHistory = vi.fn();
    render(<ExpenseWorkspace {...props} role="CASHIER" onLoad={vi.fn()} loadHistory={loadHistory} />);
    expect(screen.queryByRole('region', { name: 'Historial de gastos' })).toBeNull();
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it('registers an amount typed in Argentine format', async () => {
    const create = vi.fn().mockResolvedValue({ ...detail, amount: '2500.50' });
    render(<ExpenseWorkspace {...props} role="CASHIER" onCreate={create} onLoad={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Categoría de gasto'), 'cat');
    await userEvent.type(screen.getByLabelText('Concepto'), 'Luz');
    await userEvent.type(screen.getByLabelText('Importe'), '2.500,50');
    await userEvent.selectOptions(screen.getByLabelText('Turno de caja'), 'session');
    await userEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    expect(create).toHaveBeenCalledWith('org', expect.objectContaining({ amount: '2500.50' }), expect.any(String));
    expect(await screen.findByText('Gasto registrado.')).toBeDefined();
  });
});
