import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiProblemError } from '../src/lib/api/client.js';
import { PosCheckout } from '../src/features/sales/pos-checkout.js';

const mocks = vi.hoisted(() => ({
  loadCheckoutContext: vi.fn(), quoteSale: vi.fn(), confirmSale: vi.fn(),
}));
vi.mock('../src/features/sales/sales-api.js', () => mocks);

const lines = [{ itemId: 'item', quantity: '1' }];
const quote = (total: string) => ({ quoteFingerprint: `fingerprint-${total}`, quote: {
  currency: 'ARS', subtotal: total, discount: '0.00', total, lines: [],
} });

describe('T152C POS checkout', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('D03 preserves the original operation ID and idempotency key after an uncertain response', async () => {
    mocks.loadCheckoutContext.mockResolvedValue({ sessions: [{ id: 'session', deviceId: 'device', registerName: 'Caja' }], paymentMethods: ['CASH'] });
    mocks.quoteSale.mockResolvedValue(quote('0.00'));
    mocks.confirmSale.mockRejectedValueOnce(new Error('Lost response')).mockImplementation(async (_org, input) => ({ id: input.clientOperationId, total: '0.00', receipt: { label: 'Comprobante no fiscal' } }));
    const onConfirmed = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PosCheckout organizationId="org" branchId="branch" role="OWNER" lines={lines} onConfirmed={onConfirmed} />
    </QueryClientProvider>);
    const button = screen.getByRole('button', { name: 'Confirmar venta' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    fireEvent.click(button); await screen.findByText('No pudimos confirmar la venta. Intentá nuevamente.');
    expect(onConfirmed).not.toHaveBeenCalled();
    fireEvent.click(button); await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
    expect(mocks.confirmSale.mock.calls[1]).toEqual(mocks.confirmSale.mock.calls[0]);
    expect(onConfirmed.mock.calls[0]?.[0].id).toBe(mocks.confirmSale.mock.calls[0]?.[1].clientOperationId);
  });

  it('requires explicit acceptance and updated payments after PRICE_CHANGED', async () => {
    mocks.loadCheckoutContext.mockResolvedValue({ sessions: [{ id: 'session', deviceId: 'device',
      registerName: 'Caja principal' }], paymentMethods: ['CASH', 'TRANSFER'] });
    mocks.quoteSale.mockResolvedValueOnce(quote('10.00')).mockResolvedValue(quote('11.00'));
    mocks.confirmSale.mockRejectedValueOnce(new ApiProblemError({ status: 409, code: 'PRICE_CHANGED',
      message: 'El precio cambió.', currentTotal: '11.00' }))
      .mockResolvedValue({ id: 'sale', total: '11.00', receipt: { label: 'Comprobante no fiscal' } });
    const onConfirmed = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PosCheckout organizationId="org" branchId="branch" role="CASHIER" lines={lines}
        onConfirmed={onConfirmed} />
    </QueryClientProvider>);
    await screen.findByText('Total');
    fireEvent.click(screen.getByRole('button', { name: 'Agregar pago' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar venta' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar venta' }));
    await screen.findByText(/Nuevo total del servidor/);
    expect(screen.getByRole('button', { name: 'Confirmar venta' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Importe aplicado 1'), { target: { value: '11.00' } });
    fireEvent.click(screen.getByLabelText('Acepto el precio actualizado'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar venta' }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
    expect(mocks.confirmSale.mock.calls[1]?.[1]).toMatchObject({ previousKey: expect.any(String),
      acceptedPriceChange: true, quoteFingerprint: 'fingerprint-11.00' });
  });
});
