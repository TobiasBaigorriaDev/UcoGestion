import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomeActions } from '../src/features/insights/home-actions';

afterEach(cleanup);
const wrap = (ui: ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const open = { sessions: [{ id: 's1', deviceId: 'd1', registerName: 'Caja mostrador' }], paymentMethods: ['CASH'] };

describe('D08 home quick actions', () => {
  it('leads the owner to selling and shows which register is open', async () => {
    const load = vi.fn().mockResolvedValue(open);
    const { container } = wrap(<HomeActions organizationId="o" branchId="b" role="OWNER" loadContext={load} />);
    const actions = screen.getByRole('navigation', { name: '¿Qué querés hacer?' });
    expect(within(actions).getAllByRole('link').map(link => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Vender', '/workspace/pos'], ['Turno de caja', '/workspace/cash-sessions'], ['Cobrar a un cliente', '/workspace/customers'],
      ['Registrar compra', '/workspace/purchases'], ['Registrar gasto', '/workspace/expenses'],
    ]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Caja abierta: Caja mostrador'));
    expect(load).toHaveBeenCalledWith('o', 'b');
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('tells the cashier to open a shift when no register is open', async () => {
    wrap(<HomeActions organizationId="o" branchId="b" role="CASHIER" loadContext={vi.fn().mockResolvedValue({ sessions: [], paymentMethods: [] })} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('No hay una caja abierta'));
    const status = screen.getByRole('status');
    expect(within(status).getByRole('link', { name: 'Abrir turno de caja' }).getAttribute('href')).toBe('/workspace/cash-sessions');
    expect(screen.queryByRole('link', { name: 'Registrar compra' })).toBeNull();
  });

  it('keeps employees on stock work without querying cash', () => {
    const load = vi.fn();
    wrap(<HomeActions organizationId="o" branchId="b" role="EMPLOYEE" loadContext={load} />);
    const actions = screen.getByRole('navigation', { name: '¿Qué querés hacer?' });
    expect(within(actions).getAllByRole('link').map(link => link.textContent)).toEqual(['Ver productos', 'Registrar compra']);
    expect(screen.queryByRole('status')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('does not invent a cash state when the check fails', async () => {
    wrap(<HomeActions organizationId="o" branchId="b" role="ADMIN" loadContext={vi.fn().mockRejectedValue(new Error('offline'))} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('No pudimos consultar la caja'));
  });
});
