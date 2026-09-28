import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PosOnline } from '../src/features/sales/pos-online.js';

const mocks = vi.hoisted(() => ({
  loadCheckoutContext: vi.fn(), quoteSale: vi.fn(), confirmSale: vi.fn(),
}));
vi.mock('../src/features/sales/sales-api.js', () => mocks);

describe('consecutive POS sales', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });
  it('starts the next sale without the previous payments or discount', async () => {
    mocks.loadCheckoutContext.mockResolvedValue({ sessions: [{ id: 'session', deviceId: 'device',
      registerName: 'Caja' }], paymentMethods: ['CASH'] });
    mocks.quoteSale.mockResolvedValue({ quoteFingerprint: 'fingerprint', quote: { currency: 'ARS',
      subtotal: '10.00', discount: '0.00', total: '10.00', lines: [{ itemId: 'item',
        quantity: '1', unitPrice: '10.00', priceVersion: 1, lineTotal: '10.00' }] } });
    mocks.confirmSale.mockResolvedValue({ id: 'sale', total: '10.00',
      receipt: { label: 'Comprobante no fiscal' } });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PosOnline organizationId="org" branchId="branch" role="OWNER" items={[{
        id: 'item', name: 'Manzana', type: 'PRODUCT', status: 'ACTIVE', baseUnit: 'UNIT',
        price: '10.00', priceVersion: 1, sku: null, barcode: '779100',
      }]} />
    </QueryClientProvider>);
    fireEvent.change(screen.getByLabelText('Buscar producto'), { target: { value: 'Manzana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar Manzana' }));
    await screen.findByText('Total');
    fireEvent.change(screen.getByLabelText('Descuento global'), { target: { value: '5' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Agregar pago' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar venta' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar venta' }));
    await waitFor(() => expect(mocks.confirmSale).toHaveBeenCalledTimes(1));
    await screen.findByText('Venta confirmada');
    fireEvent.change(screen.getByLabelText('Buscar producto'), { target: { value: 'Manzana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar Manzana' }));
    expect(screen.queryByLabelText('Importe aplicado 1')).toBeNull();
    expect((screen.getByLabelText('Descuento global') as HTMLInputElement).value).toBe('');
  });
});
