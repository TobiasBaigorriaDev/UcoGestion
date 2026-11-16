import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PosCheckout } from '../src/features/sales/pos-checkout.js';
import { ApiProblemError } from '../src/lib/api/client.js';
import { PosConnectionBoundary } from '../src/offline/pos-connection-boundary';

const mocks = vi.hoisted(() => ({ loadCheckoutContext: vi.fn(), quoteSale: vi.fn(), confirmSale: vi.fn(), loadCustomers: vi.fn(), loadCustomerAccount: vi.fn() }));
vi.mock('../src/features/sales/sales-api.js', () => mocks);
vi.mock('../src/features/customers/customer-management.js', () => ({ loadCustomers: mocks.loadCustomers }));
vi.mock('../src/features/customers/customer-account-api.js', async importOriginal => ({ ...await importOriginal<object>(), loadCustomerAccount: mocks.loadCustomerAccount }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

it('recovers the original credit sale after a lost response even when refreshed credit is exhausted', async () => {
  let online = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  const originalQuote = { quoteFingerprint: 'original', quote: { total: '10.00', subtotal: '10.00', discount: '0.00', currency: 'ARS', lines: [] } };
  mocks.loadCheckoutContext.mockResolvedValue({ sessions: [{ id: 'session', deviceId: 'device', registerName: 'Caja' }], paymentMethods: ['CASH'] });
  mocks.quoteSale.mockResolvedValue(originalQuote);
  mocks.loadCustomers.mockResolvedValue([{ id: 'customer', name: 'Ana', status: 'ACTIVE' }]);
  mocks.loadCustomerAccount.mockResolvedValue({ balance: '0.00', creditLimit: '10.00', available: '10.00', currency: 'ARS', version: 1, entries: [], nextCursor: null });
  mocks.confirmSale.mockRejectedValueOnce(new ApiProblemError({ status: 0, code: 'NETWORK_ERROR', message: 'Respuesta perdida' }))
    .mockResolvedValue({ id: 'sale', total: '10.00', receipt: {} });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><PosConnectionBoundary offlinePos={<p>Desbloqueá con tu PIN</p>}><PosCheckout organizationId="org" branchId="branch" role="CASHIER"
    lines={[{ itemId: 'item', quantity: '1' }]} onConfirmed={vi.fn()} /></PosConnectionBoundary></QueryClientProvider>);
  await screen.findByRole('option', { name: 'Ana' });
  fireEvent.change(screen.getByLabelText('Cliente de la venta'), { target: { value: 'customer' } });
  fireEvent.click(screen.getByLabelText('A cuenta del cliente'));
  await screen.findAllByText('10,00 ARS');
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar venta' }));
  await screen.findByText('Respuesta perdida');
  act(() => { online = false; window.dispatchEvent(new Event('offline')); });
  expect(screen.queryByRole('button', { name: 'Confirmar venta' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Pasar al POS sin conexión' }));
  act(() => { online = true; window.dispatchEvent(new Event('online')); });
  fireEvent.click(screen.getByRole('button', { name: 'Volver al POS online' }));
  mocks.loadCustomerAccount.mockResolvedValue({ balance: '10.00', creditLimit: '10.00', available: '0.00', currency: 'ARS', version: 2, entries: [], nextCursor: null });
  mocks.quoteSale.mockResolvedValue({ ...originalQuote, quoteFingerprint: 'new-price-fingerprint' });
  await client.invalidateQueries({ queryKey: ['customer-account'] });
  await client.invalidateQueries({ queryKey: ['sale-quote'] });
  await screen.findByText('0,00 ARS');
  expect(screen.getByRole('button', { name: 'Confirmar venta' }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar venta' }));
  await waitFor(() => expect(mocks.confirmSale).toHaveBeenCalledTimes(2));
  expect(mocks.confirmSale.mock.calls[1]).toEqual(mocks.confirmSale.mock.calls[0]);
});

it('requires an active customer, permits partial credit, blocks excess and sends explicit onAccount', async () => {
  mocks.loadCheckoutContext.mockResolvedValue({ sessions: [{ id: 'session', deviceId: 'device', registerName: 'Caja' }], paymentMethods: ['CASH'] });
  mocks.quoteSale.mockResolvedValue({ quoteFingerprint: 'fingerprint', quote: { total: '10.00', subtotal: '10.00', discount: '0.00', currency: 'ARS', lines: [] } });
  mocks.loadCustomers.mockResolvedValue([{ id: 'customer', name: 'Ana', status: 'ACTIVE' }]);
  mocks.loadCustomerAccount.mockResolvedValue({ balance: '5.00', creditLimit: '12.00', available: '7.00', currency: 'ARS', version: 1, entries: [], nextCursor: null });
  mocks.confirmSale.mockResolvedValue({ id: 'sale', total: '10.00', receipt: { label: 'Comprobante no fiscal' } });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PosCheckout organizationId="org" branchId="branch" role="CASHIER" lines={[{ itemId: 'item', quantity: '1' }]} onConfirmed={vi.fn()} />
  </QueryClientProvider>);
  await screen.findByRole('option', { name: 'Ana' });
  fireEvent.click(screen.getByLabelText('A cuenta del cliente'));
  expect(screen.getByRole('button', { name: 'Confirmar venta' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Cliente de la venta'), { target: { value: 'customer' } });
  await screen.findByText(/supera el crédito disponible/);
  fireEvent.click(screen.getByRole('button', { name: 'Agregar pago' }));
  fireEvent.change(screen.getByLabelText('Importe aplicado 1'), { target: { value: '4.00' } });
  await screen.findByText('6,00 ARS');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar venta' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar venta' }));
  await waitFor(() => expect(mocks.confirmSale).toHaveBeenCalled());
  expect(mocks.confirmSale.mock.calls[0]?.[1]).toMatchObject({ customerId: 'customer', onAccount: true, payments: [{ method: 'CASH', appliedAmount: '4.00' }] });
});
