import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SaleLookup } from '../src/features/sales/sale-lookup.js';

const mocks = vi.hoisted(() => ({ loadSaleDetail: vi.fn(), loadCheckoutContext: vi.fn(), cancelSale: vi.fn() }));
vi.mock('../src/features/sales/sales-api.js', () => mocks);

const sale = { id: '11111111-1111-4111-8111-111111111111', branchId: 'branch', status: 'CONFIRMED',
  total: '10.00', currency: 'ARS', confirmedAt: '2026-09-27T12:00:00Z', canCancel: true,
  cancellation: null, items: [{ name: 'Producto', quantity: '1.000', unitPrice: '10.00', lineTotal: '10.00' }],
  payments: [{ method: 'TRANSFER', amount: '10.00', change: '0.00' }] };

describe('T152B sale lookup', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });
  it('loads sale details and requires a reason before cancellation', async () => {
    mocks.loadSaleDetail.mockResolvedValueOnce(sale).mockResolvedValue({ ...sale, status: 'CANCELLED',
      canCancel: false, cancellation: { reason: 'Error de carga', cancelledAt: '2026-09-27T12:01:00Z' } });
    mocks.cancelSale.mockResolvedValue(undefined);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SaleLookup organizationId="org" branchId="branch" role="OWNER" />
    </QueryClientProvider>);
    fireEvent.change(screen.getByLabelText('ID de venta'), { target: { value: sale.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Consultar venta' }));
    await screen.findByText(/Producto ·/);
    expect(screen.getByRole('button', { name: 'Anular venta' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo de anulación'), { target: { value: 'Error de carga' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anular venta' }));
    await waitFor(() => expect(mocks.cancelSale).toHaveBeenCalledTimes(1));
    expect(mocks.cancelSale.mock.calls[0]?.[2]).toMatchObject({ reason: 'Error de carga' });
    await screen.findByText(/Error de carga/);
  });
});
