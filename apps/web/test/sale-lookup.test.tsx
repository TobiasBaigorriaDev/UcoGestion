import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SaleLookup } from '../src/features/sales/sale-lookup.js';
import { saleCodeFromId } from '@uconext/shared';

const mocks = vi.hoisted(() => ({ loadSaleDetail: vi.fn(), loadCheckoutContext: vi.fn(), cancelSale: vi.fn(),
  loadSaleHistory: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  loadSaleTrends: vi.fn().mockResolvedValue({ currency: 'ARS', points: [] }) }));
vi.mock('../src/features/sales/sales-api.js', () => mocks);

const sale = { id: '11111111-1111-4111-8111-111111111111', branchId: 'branch', status: 'CONFIRMED',
  total: '10.00', currency: 'ARS', confirmedAt: '2026-09-27T12:00:00Z', canCancel: true,
  cancellation: null, items: [{ name: 'Producto', quantity: '1.000', unitPrice: '10.00', lineTotal: '10.00' }],
  payments: [{ method: 'TRANSFER', amount: '10.00', change: '0.00' }] };

describe('T152B sale lookup', () => {
  beforeEach(() => {
    mocks.loadSaleHistory.mockResolvedValue({ items: [], nextCursor: null });
    mocks.loadSaleTrends.mockResolvedValue({ currency: 'ARS', points: [] });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
  it('shows history, paginates and opens the existing detail from a sale', async () => {
    mocks.loadSaleHistory.mockResolvedValueOnce({ items: [sale], nextCursor: 'page-2' })
      .mockResolvedValue({ items: [{ ...sale, status: 'CANCELLED' }], nextCursor: null });
    mocks.loadSaleDetail.mockResolvedValue(sale);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SaleLookup organizationId="org" branchId="branch" role="OWNER" />
    </QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: `Ver venta ${saleCodeFromId(sale.id)}` }));
    await screen.findByText(/Producto ·/);
    expect(mocks.loadSaleDetail).toHaveBeenCalledWith('org', sale.id);
    expect(document.activeElement).toBe(screen.getByRole('region', { name: `Venta ${saleCodeFromId(sale.id)}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    await waitFor(() => expect(mocks.loadSaleHistory).toHaveBeenLastCalledWith('org', 'branch',
      expect.objectContaining({ cursor: 'page-2' })));
    fireEvent.change(screen.getByLabelText('Estado de venta'), { target: { value: 'CANCELLED' } });
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-09-27' } });
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-09-27' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar filtros' }));
    await waitFor(() => expect(mocks.loadSaleHistory).toHaveBeenLastCalledWith('org', 'branch',
      expect.objectContaining({ status: 'CANCELLED', from: '2026-09-27', to: '2026-09-27', cursor: undefined })));
    expect(screen.getByRole('button', { name: 'Anterior' }).hasAttribute('disabled')).toBe(true);
  });
  it('filters charts and history by period and authorized branch', async () => {
    mocks.loadSaleTrends.mockResolvedValue({ currency: 'ARS', points: [
      { date: '2026-10-11', amount: '25.00', count: 2 },
    ] });
    const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SaleLookup organizationId="org" branchId="branch" role="OWNER" timezone="America/Argentina/Buenos_Aires"
        branches={[{ id: 'branch', name: 'Principal' }, { id: 'other', name: 'Secundaria' }]} />
    </QueryClientProvider>);
    expect(await screen.findByText('25,00 ARS')).toBeDefined();
    expect(view.container.querySelectorAll('svg polyline').length).toBe(2);
    expect(mocks.loadSaleTrends).toHaveBeenCalledWith('org',
      expect.objectContaining({ groupBy: 'HOUR' }));
    fireEvent.click(screen.getByRole('button', { name: 'Esta semana' }));
    await waitFor(() => expect(mocks.loadSaleTrends).toHaveBeenLastCalledWith('org',
      expect.objectContaining({ branchId: 'branch' })));
    fireEvent.change(screen.getByLabelText('Sucursal'), { target: { value: 'other' } });
    await waitFor(() => expect(mocks.loadSaleHistory).toHaveBeenLastCalledWith('org', 'other',
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) })));
    await waitFor(() => expect(mocks.loadSaleTrends).toHaveBeenLastCalledWith('org',
      expect.objectContaining({ branchId: 'other' })));
    fireEvent.change(screen.getByLabelText('Sucursal'), { target: { value: '' } });
    await waitFor(() => expect(mocks.loadSaleTrends).toHaveBeenLastCalledWith('org',
      expect.objectContaining({ branchId: undefined })));
  });
  it('shows several value and time references on both sales charts', async () => {
    mocks.loadSaleTrends.mockResolvedValue({ currency: 'ARS', points: Array.from({ length: 24 }, (_, hour) => ({
      date: '2025-01-01', hour, amount: hour === 12 ? '120.00' : '0.00', count: hour === 12 ? 3 : 0,
    })) });
    const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SaleLookup organizationId="org" branchId="branch" role="OWNER" />
    </QueryClientProvider>);
    await screen.findByText('120,00 ARS');
    for (const chart of view.container.querySelectorAll('svg:has(polyline)')) {
      expect(chart.querySelectorAll('[data-axis="value"]')).toHaveLength(5);
      expect(chart.querySelectorAll('[data-axis="time"]')).toHaveLength(5);
      expect(chart.textContent).toContain('00:00 h');
      expect(chart.textContent).toContain('23:00 h');
    }
  });
  it('ends today’s charts at the current local hour and omits future hours from the table', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T15:30:00Z')); // 12:30 in Buenos Aires
    mocks.loadSaleTrends.mockResolvedValue({ currency: 'ARS', points: Array.from({ length: 24 }, (_, hour) => ({
      date: '2026-10-11', hour, amount: '0.00', count: 0,
    })) });
    const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SaleLookup organizationId="org" branchId="branch" role="OWNER" timezone="America/Argentina/Buenos_Aires" />
    </QueryClientProvider>);
    await screen.findByText('Máximo: 0,00 ARS');
    for (const chart of view.container.querySelectorAll('section[aria-label="Dinero vendido"], section[aria-label="Cantidad de ventas"]')) {
      expect(chart.querySelectorAll('svg circle')).toHaveLength(13);
      expect(chart.querySelectorAll('tbody tr')).toHaveLength(13);
      expect(chart.querySelector('svg')?.textContent).toContain('12:00 h');
      expect(chart.textContent).not.toContain('13:00 h');
    }
  });
  it('omits future calendar days in the current month while retaining past dates', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T15:30:00Z'));
    mocks.loadSaleTrends.mockImplementation(async (_organizationId, filters) => ({ currency: 'ARS',
      points: filters.groupBy === 'DAY' ? Array.from({ length: 31 }, (_, index) => ({
        date: `2026-10-${String(index + 1).padStart(2, '0')}`, amount: '0.00', count: 0,
      })) : [],
    }));
    const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SaleLookup organizationId="org" branchId="branch" role="OWNER" timezone="America/Argentina/Buenos_Aires" />
    </QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Este mes' }));
    await waitFor(() => expect(view.container.querySelectorAll('section[aria-label="Dinero vendido"] tbody tr')).toHaveLength(11));
    expect(view.container.querySelector('section[aria-label="Dinero vendido"]')?.textContent).not.toContain('12 oct');
  });
  it('spaces weekly date references so the last two days do not collide', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T15:30:00Z'));
    mocks.loadSaleTrends.mockImplementation(async (_organizationId, filters) => ({ currency: 'ARS',
      points: filters.groupBy === 'DAY' ? Array.from({ length: 7 }, (_, index) => ({
        date: `2026-10-${String(index + 5).padStart(2, '0')}`, amount: '0.00', count: 0,
      })) : [],
    }));
    const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SaleLookup organizationId="org" branchId="branch" role="OWNER" timezone="America/Argentina/Buenos_Aires" />
    </QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Esta semana' }));
    await waitFor(() => expect(view.container.querySelectorAll('section[aria-label="Dinero vendido"] tbody tr')).toHaveLength(7));
    for (const chart of view.container.querySelectorAll('svg:has(polyline)')) {
      expect(Array.from(chart.querySelectorAll('[data-axis="time"]'), label => label.textContent))
        .toEqual(['5 oct', '8 oct', '11 oct']);
    }
  });
  it('rejects reversed dates and resets selection and filters on branch change', async () => {
    mocks.loadSaleHistory.mockResolvedValue({ items: [sale], nextCursor: null });
    mocks.loadSaleDetail.mockResolvedValue(sale);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}>
      <SaleLookup organizationId="org" branchId="branch" role="OWNER" />
    </QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: `Ver venta ${saleCodeFromId(sale.id)}` }));
    await screen.findByText(/Producto ·/);
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-09-28' } });
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-09-27' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar filtros' }));
    expect(await screen.findByText('La fecha Desde debe ser anterior o igual a Hasta.')).toBeDefined();
    view.rerender(<QueryClientProvider client={client}>
      <SaleLookup organizationId="org" branchId="other" role="OWNER" />
    </QueryClientProvider>);
    await waitFor(() => expect(mocks.loadSaleHistory).toHaveBeenLastCalledWith('org', 'other',
      expect.objectContaining({ cursor: undefined })));
    expect(screen.queryByText(/Producto ·/)).toBeNull();
    expect((screen.getByLabelText('Desde') as HTMLInputElement).value).toBeTruthy();
  });
  it('shows an actionable error and allows retrying history', async () => {
    mocks.loadSaleHistory.mockRejectedValueOnce(new Error('offline'));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SaleLookup organizationId="org" branchId="branch" role="OWNER" />
    </QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('No hay ventas para estos filtros.')).toBeDefined();
  });
  it('D03 rejects references and invalid IDs with an accessible error before querying', async () => {
    render(<QueryClientProvider client={new QueryClient()}><SaleLookup organizationId="org" branchId="branch" role="OWNER" /></QueryClientProvider>);
    for (const invalid of ['OFF-device-sale', 'not-a-uuid']) {
      fireEvent.change(screen.getByLabelText('ID de venta'), { target: { value: invalid } });
      fireEvent.click(screen.getByRole('button', { name: 'Consultar venta' }));
      expect(await screen.findByText('Ingresá los 12 caracteres del comprobante o un ID de venta anterior completo.')).toBeDefined();
      expect(screen.getByRole('alert')).toBeDefined();
      expect(mocks.loadSaleDetail).not.toHaveBeenCalled();
    }
  });
  it('loads sale details and requires a reason before cancellation', async () => {
    mocks.loadSaleDetail.mockResolvedValueOnce(sale).mockResolvedValue({ ...sale, status: 'CANCELLED',
      canCancel: false, cancellation: { reason: 'Error de carga', cancelledAt: '2026-09-27T12:01:00Z' } });
    mocks.cancelSale.mockResolvedValue(undefined);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SaleLookup organizationId="org" branchId="branch" role="OWNER" />
    </QueryClientProvider>);
    const input = screen.getByLabelText('ID de venta');
    const helpId = input.getAttribute('aria-describedby');
    expect(helpId).toBeTruthy();
    expect(document.getElementById(helpId ?? '')?.textContent).toContain('Ingresá los 12 caracteres del ID de venta que aparece en el comprobante no fiscal');
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
