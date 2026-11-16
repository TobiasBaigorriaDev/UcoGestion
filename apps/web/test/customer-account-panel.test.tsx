import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';
import { CustomerAccountPanel } from '../src/features/customers/customer-account-panel.js';

const mocks = vi.hoisted(() => ({ loadCustomerAccount: vi.fn(), collectCustomerDebt: vi.fn(), setCustomerCreditLimit: vi.fn(), reverseCustomerCollection: vi.fn(), loadCheckoutContext: vi.fn() }));
vi.mock('../src/features/customers/customer-account-api.js', async importOriginal => ({ ...await importOriginal<object>(), ...mocks }));
vi.mock('../src/features/sales/sales-api.js', () => mocks);
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function panel(role: 'OWNER' | 'CASHIER', client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  mocks.loadCustomerAccount.mockResolvedValue({ balance: '30.00', creditLimit: '100.00', available: '70.00', currency: 'ARS', version: 2, entries: [], nextCursor: null });
  mocks.loadCheckoutContext.mockResolvedValue({ sessions: [{ id: 'session', deviceId: 'device', registerName: 'Mostrador' }], paymentMethods: ['CASH','TRANSFER'] });
  return render(<QueryClientProvider client={client}>
    <CustomerAccountPanel organizationId="org" branchId="branch" customerId="customer" customerName="Ana" role={role} onReload={vi.fn()} />
  </QueryClientProvider>);
}
it('recovers a full collection after lost response when a refresh already shows zero debt', async () => {
  mocks.collectCustomerDebt.mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue({ id: 'entry', balance: '0.00', currency: 'ARS' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  panel('CASHIER', client); await screen.findByText('30,00 ARS');
  fireEvent.change(screen.getByLabelText('Importe a cobrar'), { target: { value: '30' } });
  fireEvent.click(screen.getByRole('button', { name: 'Registrar cobro' }));
  await screen.findByText(/No pudimos completar/);
  mocks.loadCustomerAccount.mockResolvedValue({ balance: '0.00', creditLimit: '100.00', available: '100.00', currency: 'ARS', version: 3, entries: [], nextCursor: null });
  await client.invalidateQueries({ queryKey: ['customer-account'] });
  await screen.findByText('0,00 ARS');
  expect(screen.getByRole('button', { name: 'Registrar cobro' }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Registrar cobro' }));
  await waitFor(() => expect(mocks.collectCustomerDebt).toHaveBeenCalledTimes(2));
  expect(mocks.collectCustomerDebt.mock.calls[1]).toEqual(mocks.collectCustomerDebt.mock.calls[0]);
});
it('replays the original limit version after a lost response and refreshed account', async () => {
  mocks.setCustomerCreditLimit.mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue({});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  panel('OWNER', client); await screen.findByText('30,00 ARS');
  fireEvent.change(screen.getByLabelText('Tope de deuda'), { target: { value: '150' } });
  fireEvent.click(screen.getByRole('button', { name: 'Guardar tope' }));
  await screen.findByText(/No pudimos completar/);
  mocks.loadCustomerAccount.mockResolvedValue({ balance: '30.00', creditLimit: '150.00', available: '120.00', currency: 'ARS', version: 3, entries: [], nextCursor: null });
  await client.invalidateQueries({ queryKey: ['customer-account'] });
  await screen.findByText('150,00 ARS');
  fireEvent.click(screen.getByRole('button', { name: 'Guardar tope' }));
  await waitFor(() => expect(mocks.setCustomerCreditLimit).toHaveBeenCalledTimes(2));
  expect(mocks.setCustomerCreditLimit.mock.calls[1]).toEqual(mocks.setCustomerCreditLimit.mock.calls[0]);
});
it('shows debt and credit, hides limit editing from cashier and keeps the same collection key after lost response', async () => {
  mocks.collectCustomerDebt.mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue({ id: 'entry', balance: '20.00', currency: 'ARS' });
  const { container } = panel('CASHIER');
  await screen.findByText('30,00 ARS');
  expect(screen.queryByRole('button', { name: 'Guardar tope' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Importe a cobrar'), { target: { value: '10,00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Registrar cobro' }));
  await screen.findByText(/No pudimos completar/);
  fireEvent.click(screen.getByRole('button', { name: 'Registrar cobro' }));
  await waitFor(() => expect(mocks.collectCustomerDebt).toHaveBeenCalledTimes(2));
  expect(mocks.collectCustomerDebt.mock.calls[1]).toEqual(mocks.collectCustomerDebt.mock.calls[0]);
  expect(mocks.collectCustomerDebt.mock.calls[0]?.[2]).toMatchObject({ amount: '10.00', cashSessionId: 'session', deviceId: 'device', method: 'CASH' });
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});
it('lets owner update a versioned limit and prevents collecting over the visible debt', async () => {
  mocks.setCustomerCreditLimit.mockResolvedValue({});
  panel('OWNER'); await screen.findByText('30,00 ARS');
  fireEvent.change(screen.getByLabelText('Tope de deuda'), { target: { value: '150' } });
  fireEvent.click(screen.getByRole('button', { name: 'Guardar tope' }));
  await waitFor(() => expect(mocks.setCustomerCreditLimit).toHaveBeenCalled());
  expect(mocks.setCustomerCreditLimit.mock.calls[0]?.slice(0, 4)).toEqual(['org','customer',2,'150.00']);
  fireEvent.change(screen.getByLabelText('Importe a cobrar'), { target: { value: '31' } });
  fireEvent.click(screen.getByRole('button', { name: 'Registrar cobro' }));
  await screen.findByText('El cobro no puede superar la deuda actual.');
  expect(mocks.collectCustomerDebt).not.toHaveBeenCalled();
});
