import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PosCheckout } from '../src/features/sales/pos-checkout.js';
import { parseMoneyInput } from '../src/features/sales/pos-payment-rules.js';

const mocks = vi.hoisted(() => ({ loadCheckoutContext: vi.fn(), quoteSale: vi.fn(), confirmSale: vi.fn() }));
vi.mock('../src/features/sales/sales-api.js', () => mocks);

const lines = [{ itemId: 'item', quantity: '1' }];
const quote = (total: string) => ({ quoteFingerprint: `f-${total}`, quote: { currency: 'ARS', subtotal: total, discount: '0.00', total, lines: [] } });
const one = { sessions: [{ id: 's1', deviceId: 'd1', registerName: 'Caja mostrador' }], paymentMethods: ['CASH', 'DEBIT_CARD'] };
const view = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <PosCheckout organizationId="org" branchId="branch" role="CASHIER" lines={lines} onConfirmed={vi.fn()} />
</QueryClientProvider>);

describe('D08 counter checkout', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('reads amounts the way a cashier types them, exactly and without guessing', () => {
    expect(['5000', '5000,5', '5.000', '5.000,50', '25.50', '0,75', ' 1200 '].map(parseMoneyInput))
      .toEqual(['5000.00', '5000.50', '5000.00', '5000.50', '25.50', '0.75', '1200.00']);
    for (const invalid of ['', 'abc', '1,234,5', '5.00.0', '-3', '1,555', '12.3456']) expect(parseMoneyInput(invalid)).toBeNull();
  });

  it('charges the whole total with one tap on a payment method', async () => {
    mocks.loadCheckoutContext.mockResolvedValue(one);
    mocks.quoteSale.mockResolvedValue(quote('4500.00'));
    mocks.confirmSale.mockResolvedValue({ id: 'sale', total: '4500.00', receipt: { label: 'Comprobante no fiscal' } });
    view();
    expect(await screen.findByText('$ 4.500,00', { selector: '[data-total]' })).toBeDefined();
    fireEvent.click(await screen.findByRole('button', { name: 'Cobrar todo con Débito' }));
    const confirm = screen.getByRole('button', { name: 'Confirmar venta' });
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.confirmSale).toHaveBeenCalledTimes(1));
    expect(mocks.confirmSale.mock.calls[0]?.[1].payments).toEqual([{ method: 'DEBIT_CARD', appliedAmount: '4500.00' }]);
  });

  it('computes change from cash typed in Argentine format', async () => {
    mocks.loadCheckoutContext.mockResolvedValue(one);
    mocks.quoteSale.mockResolvedValue(quote('4500.00'));
    mocks.confirmSale.mockResolvedValue({ id: 'sale', total: '4500.00', receipt: { label: 'Comprobante no fiscal' } });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Cobrar todo con Efectivo' }));
    fireEvent.change(screen.getByLabelText('Efectivo recibido 1'), { target: { value: '5.000' } });
    expect(await screen.findByText('Vuelto: $ 500,00')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar venta' }));
    await waitFor(() => expect(mocks.confirmSale).toHaveBeenCalledTimes(1));
    expect(mocks.confirmSale.mock.calls[0]?.[1].payments).toEqual([{ method: 'CASH', appliedAmount: '4500.00', receivedAmount: '5000.00' }]);
  });

  it('names the open register instead of asking when there is only one', async () => {
    mocks.loadCheckoutContext.mockResolvedValue(one);
    mocks.quoteSale.mockResolvedValue(quote('10.00'));
    view();
    expect(await screen.findByText('Caja mostrador')).toBeDefined();
    expect(screen.queryByRole('combobox', { name: 'Caja' })).toBeNull();
  });

  it('lets the cashier choose between several open registers', async () => {
    mocks.loadCheckoutContext.mockResolvedValue({ ...one, sessions: [...one.sessions, { id: 's2', deviceId: 'd2', registerName: 'Caja 2' }] });
    mocks.quoteSale.mockResolvedValue(quote('10.00'));
    view();
    expect(within(await screen.findByRole('combobox', { name: 'Caja' })).getAllByRole('option').map(option => option.textContent))
      .toEqual(['Caja mostrador', 'Caja 2']);
  });

  it('sends the cashier to open a shift when no register is open', async () => {
    mocks.loadCheckoutContext.mockResolvedValue({ sessions: [], paymentMethods: ['CASH'] });
    mocks.quoteSale.mockResolvedValue(quote('10.00'));
    view();
    const alert = (await screen.findByText(/No hay una caja abierta/)).closest('[role="alert"]') as HTMLElement;
    expect(alert).not.toBeNull();
    expect(within(alert).getByRole('link', { name: 'Abrir turno de caja' }).getAttribute('href')).toBe('/workspace/cash-sessions');
    expect(screen.getByRole('button', { name: 'Confirmar venta' }).hasAttribute('disabled')).toBe(true);
  });
});
