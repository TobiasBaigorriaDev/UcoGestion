import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { PurchaseLookup } from '../src/features/purchases/purchase-lookup.js';

afterEach(cleanup);
const id = '11111111-1111-4111-8111-111111111111';
const base = { id, branchId: 'branch', status: 'PENDING_PAYMENT' as const, total: '3.00',
  currency: 'ARS', supplierName: 'Proveedor', confirmedAt: '2026-09-27T00:00:00Z',
  items: [{ itemName: 'Producto', quantity: '1.000', unitCost: '3.00', lineTotal: '3.00' }],
  payment: null, cancellation: null };

it('T173C pays exact pending balance and shows historical state', async () => {
  const pay = vi.fn().mockResolvedValue(undefined);
  const onChanged = vi.fn();
  const load = vi.fn().mockResolvedValueOnce(base).mockResolvedValueOnce({ ...base, status: 'PAID',
    payment: { method: 'TRANSFER', amount: '3.00' } });
  const { container } = render(<PurchaseLookup organizationId="org" branchId="branch"
    role="OWNER" paymentMethods={['TRANSFER']} sessions={[]} onLoad={load} onPay={pay} onChanged={onChanged} />);
  await userEvent.type(screen.getByLabelText('ID de compra'), id);
  await userEvent.click(screen.getByRole('button', { name: 'Consultar compra' }));
  expect(await screen.findByText('Pendiente de pago')).toBeTruthy();
  await userEvent.selectOptions(screen.getByLabelText('Medio de pago'), 'TRANSFER');
  await userEvent.click(screen.getByRole('button', { name: 'Pagar compra' }));
  expect(pay).toHaveBeenCalledWith('org', id, { method: 'TRANSFER', amount: '3.00' }, expect.any(String));
  expect(await screen.findByText('Pagada')).toBeTruthy();
  expect(onChanged).toHaveBeenCalledOnce();
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

it('T173C cancels paid purchase with reason and no session for noncash', async () => {
  const cancel = vi.fn().mockResolvedValue(undefined);
  const onChanged = vi.fn();
  const load = vi.fn().mockResolvedValueOnce({ ...base, status: 'PAID',
    payment: { method: 'TRANSFER', amount: '3.00' } }).mockResolvedValueOnce({ ...base,
    status: 'CANCELLED', payment: { method: 'TRANSFER', amount: '3.00' },
    cancellation: { reason: 'Error', cancelledAt: '2026-09-27T01:00:00Z' } });
  render(<PurchaseLookup organizationId="org" branchId="branch" role="ADMIN"
    paymentMethods={['TRANSFER']} sessions={[]} onLoad={load} onCancel={cancel} onChanged={onChanged} />);
  await userEvent.type(screen.getByLabelText('ID de compra'), id);
  await userEvent.click(screen.getByRole('button', { name: 'Consultar compra' }));
  await userEvent.type(await screen.findByLabelText('Motivo de anulación'), 'Error');
  await userEvent.click(screen.getByRole('button', { name: 'Anular compra' }));
  expect(cancel).toHaveBeenCalledWith('org', id, { reason: 'Error' }, expect.any(String));
  expect(await screen.findByText('Anulada')).toBeTruthy();
  expect(onChanged).toHaveBeenCalledOnce();
});

it('T173C explains a zero-total pending reception without offering an invalid payment', async () => {
  render(<PurchaseLookup organizationId="org" branchId="branch" role="OWNER"
    paymentMethods={['TRANSFER']} sessions={[]}
    onLoad={vi.fn().mockResolvedValue({ ...base, total: '0.00' })} />);
  await userEvent.type(screen.getByLabelText('ID de compra'), id);
  await userEvent.click(screen.getByRole('button', { name: 'Consultar compra' }));
  expect(await screen.findByText(/total cero/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Pagar compra' })).toBeNull();
});

it('presents the selected purchase as a scannable document with item costs and separate actions', async () => {
  render(<PurchaseLookup organizationId="org" branchId="branch" role="OWNER"
    paymentMethods={['TRANSFER']} sessions={[]} selectedId={id}
    onLoad={vi.fn().mockResolvedValue(base)} />);
  const detail = await screen.findByRole('region', { name: 'Detalle de compra' });
  expect(detail.querySelector('h2')?.textContent).toBe('Detalle de compra');
  expect(screen.getByText('Proveedor', { selector: 'dt' }).nextElementSibling?.textContent).toBe('Proveedor');
  expect(screen.getByText('Total de la compra', { selector: 'dt' }).nextElementSibling?.textContent).toContain('3,00 ARS');
  expect(screen.getByRole('list', { name: 'Productos de la compra' }).textContent).toContain('Producto');
  expect(screen.getByRole('heading', { name: 'Registrar pago' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Anulación total' })).toBeTruthy();
});
