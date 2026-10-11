import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axe from 'axe-core';

import { DashboardWorkspace } from '../src/features/insights/dashboard-workspace';

afterEach(cleanup);

function withQuery(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}

describe('dashboard por rol', () => {
  const summary = { role: 'OWNER', branchIds: [], sales: { net: '125.00', count: 2, averageTicket: '62.50' },
    expenses: { net: '20.00' }, purchases: { net: '30.00' }, operatingResult: { amount: '105.00', label: 'Resultado operativo' },
    paymentMethods: [{ method: 'CASH', total: '125.00' }], topItems: [], lowStock: [], cashSessions: [], cashSummary: [] };
  it('queries calendar presets and only applies complete inclusive custom ranges', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue(summary);
    withQuery(<DashboardWorkspace organizationId="o1" role="OWNER" timezone="America/Argentina/Buenos_Aires" branches={[]} load={load} now={new Date('2026-10-11T12:00:00Z')} />);
    await waitFor(() => expect(load).toHaveBeenLastCalledWith('o1', { from: '2026-10-11T03:00:00.000Z', to: '2026-10-12T03:00:00.000Z' }));
    await user.click(screen.getByRole('button', { name: 'Esta semana' }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith('o1', { from: '2026-10-05T03:00:00.000Z', to: '2026-10-12T03:00:00.000Z' }));
    await user.click(screen.getByRole('button', { name: 'Este mes' }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith('o1', { from: '2026-10-01T03:00:00.000Z', to: '2026-11-01T03:00:00.000Z' }));
    await user.click(screen.getByRole('button', { name: 'Personalizado' }));
    const calls = load.mock.calls.length;
    await user.clear(screen.getByLabelText('Desde')); await user.type(screen.getByLabelText('Desde'), '2026-02-15');
    await user.clear(screen.getByLabelText('Hasta')); await user.type(screen.getByLabelText('Hasta'), '2026-02-15');
    expect(load.mock.calls.length).toBe(calls);
    await user.click(screen.getByRole('button', { name: 'Aplicar período' }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith('o1', { from: '2026-02-15T03:00:00.000Z', to: '2026-02-16T03:00:00.000Z' }));
    await user.clear(screen.getByLabelText('Hasta'));
    await user.click(screen.getByRole('button', { name: 'Aplicar período' }));
    expect(screen.getByRole('alert').textContent).toMatch(/fecha/i);
  });
  it('keeps the cashier view limited to own sales and cash sessions', async () => {
    withQuery(<DashboardWorkspace organizationId="o1" role="CASHIER" timezone="UTC" branches={[]}
      load={vi.fn().mockResolvedValue({ role: 'CASHIER', branchIds: [], sales: summary.sales, cashSessions: [] })} />);
    expect(await screen.findByText('Ventas netas')).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Medios de pago' })).toBeNull();
    expect(screen.queryByText('Gastos netos')).toBeNull();
  });
  it('muestra las métricas y el equivalente textual de los datos comerciales', async () => {
    const load = vi.fn().mockResolvedValue({ role: 'OWNER', branchIds: ['b1'],
      sales: { net: '125.00', count: 2, averageTicket: '62.50' }, expenses: { net: '20.00' },
      purchases: { net: '30.00' }, operatingResult: { amount: '105.00', label: 'Resultado operativo' },
      paymentMethods: [{ method: 'CASH', total: '125.00' }],
      topItems: [{ itemId: 'i1', name: 'Manzanas', quantity: '2.000', total: '125.00' }],
      lowStock: [], cashSessions: [], cashSummary: [] });
    withQuery(<DashboardWorkspace organizationId="o1" role="OWNER" timezone="America/Argentina/Buenos_Aires" branches={[{ id: 'b1', name: 'Centro' }]}
      load={load} />);
    expect(await screen.findByText('Resultado operativo')).toBeDefined();
    expect(screen.getByText('Manzanas')).toBeDefined();
    expect(screen.getByText('Efectivo')).toBeDefined();
    expect(screen.getByRole('region', { name: 'Actividad del período' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Medios de pago' })).toBeDefined();
    expect(screen.getByText('Cantidad: 2.000')).toBeDefined();
    expect(screen.queryByText(/margen|rentabilidad/i)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Sucursal del dashboard'), 'b1');
    await waitFor(() => expect(load).toHaveBeenLastCalledWith('o1', expect.objectContaining({ branchId: 'b1' })));
  });

  it('limita la vista de empleado a catálogo e inventario', async () => {
    const { container } = withQuery(<DashboardWorkspace organizationId="o1" role="EMPLOYEE" timezone="America/Argentina/Buenos_Aires" branches={[]}
      load={vi.fn().mockResolvedValue({ role: 'EMPLOYEE', branchIds: [], catalog: [], inventory: [] })} />);
    expect(await screen.findByRole('heading', { name: 'Catálogo e inventario' })).toBeDefined();
    expect(screen.queryByText('Resultado operativo')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Esta semana' })).toBeNull();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
