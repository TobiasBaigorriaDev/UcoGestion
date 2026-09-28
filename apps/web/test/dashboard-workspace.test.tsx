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
    expect(screen.queryByText(/margen|rentabilidad/i)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Sucursal del dashboard'), 'b1');
    await waitFor(() => expect(load).toHaveBeenLastCalledWith('o1', expect.objectContaining({ branchId: 'b1' })));
  });

  it('limita la vista de empleado a catálogo e inventario', async () => {
    const { container } = withQuery(<DashboardWorkspace organizationId="o1" role="EMPLOYEE" timezone="America/Argentina/Buenos_Aires" branches={[]}
      load={vi.fn().mockResolvedValue({ role: 'EMPLOYEE', branchIds: [], catalog: [], inventory: [] })} />);
    expect(await screen.findByRole('heading', { name: 'Catálogo e inventario' })).toBeDefined();
    expect(screen.queryByText('Resultado operativo')).toBeNull();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
