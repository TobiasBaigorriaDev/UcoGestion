import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { PurchaseCreation } from '../src/features/purchases/purchase-creation.js';
import { ApiProblemError } from '../src/lib/api/client.js';

afterEach(cleanup);

const props = {
  organizationId: 'org', branchId: 'branch',
  suppliers: [{ id: 'supplier', name: 'Proveedor' }],
  items: [{ id: 'item', name: 'Producto', baseUnit: 'UNIT' as const }],
  paymentMethods: ['CASH', 'TRANSFER'], sessions: [{ id: 'session', deviceId: 'device', registerName: 'Caja' }],
  onConfirm: vi.fn().mockResolvedValue({ id: 'purchase', status: 'PENDING_PAYMENT', total: '0.00', currency: 'ARS' }),
};

it('T173A limits EMPLOYEE to reception and accepts zero unit cost', async () => {
  const confirm = vi.fn().mockResolvedValue({ id: 'purchase', status: 'PENDING_PAYMENT', total: '0.00', currency: 'ARS' });
  const { container } = render(<PurchaseCreation {...props} role="EMPLOYEE" onConfirm={confirm} />);
  expect(screen.queryByRole('option', { name: 'Pagada' })).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText('Proveedor'), 'supplier');
  await userEvent.selectOptions(screen.getByLabelText('Producto'), 'item');
  await userEvent.type(screen.getByLabelText('Cantidad'), '1');
  await userEvent.type(screen.getByLabelText('Costo unitario'), '0.00');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar recepción' }));
  expect(confirm).toHaveBeenCalledWith('org', expect.objectContaining({ branchId: 'branch',
    supplierId: 'supplier', lines: [{ itemId: 'item', quantity: '1', unitCost: '0.00' }] }), 'PENDING_PAYMENT', null, expect.any(String));
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

it('T173A confirms a zero-total OWNER purchase as PAID without payment', async () => {
  const confirm = vi.fn().mockResolvedValue({ id: 'purchase', status: 'PAID', total: '0.00', currency: 'ARS' });
  render(<PurchaseCreation {...props} role="OWNER" onConfirm={confirm} />);
  await userEvent.selectOptions(screen.getByLabelText('Proveedor'), 'supplier');
  await userEvent.selectOptions(screen.getByLabelText('Producto'), 'item');
  await userEvent.type(screen.getByLabelText('Cantidad'), '1');
  await userEvent.type(screen.getByLabelText('Costo unitario'), '0.00');
  await userEvent.selectOptions(screen.getByLabelText('Estado al confirmar'), 'PAID');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar compra' }));
  expect(confirm).toHaveBeenCalledWith('org', expect.any(Object), 'PAID', null, expect.any(String));
});

it('T173A requires a session for cash and keeps lines after a payment error', async () => {
  const confirm = vi.fn().mockRejectedValue(new ApiProblemError({ status: 409,
    code: 'CASH_INSUFFICIENT_EXPECTED', message: 'Registrá un ingreso antes de pagar.' }));
  render(<PurchaseCreation {...props} role="ADMIN" onConfirm={confirm} />);
  await userEvent.selectOptions(screen.getByLabelText('Proveedor'), 'supplier');
  await userEvent.selectOptions(screen.getByLabelText('Producto'), 'item');
  await userEvent.type(screen.getByLabelText('Cantidad'), '2');
  await userEvent.type(screen.getByLabelText('Costo unitario'), '3.25');
  await userEvent.selectOptions(screen.getByLabelText('Estado al confirmar'), 'PAID');
  await userEvent.selectOptions(screen.getByLabelText('Medio de pago'), 'CASH');
  expect((screen.getByRole('button', { name: 'Confirmar compra' }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.selectOptions(screen.getByLabelText('Sesión de caja'), 'session');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar compra' }));
  expect(confirm).toHaveBeenCalledWith('org', expect.any(Object), 'PAID',
    { method: 'CASH', amount: '6.50', cashSessionId: 'session', deviceId: 'device' }, expect.any(String));
  expect(await screen.findByText(/Registrá un ingreso antes de pagar/i)).toBeTruthy();
  expect((screen.getByLabelText('Costo unitario') as HTMLInputElement).value).toBe('3.25');
});
