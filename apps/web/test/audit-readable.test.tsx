import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuditWorkspace } from '../src/features/insights/audit-workspace';

afterEach(cleanup);
const event = (id: string, action: string, actorUserId: string) => ({ id, action, actorUserId, entityType: action.split('.')[0] ?? 'x',
  entityId: 'e', branchId: 'b1', occurredAt: '2026-10-09T12:00:00.000Z' });
const view = (load: (organizationId: string, filters: object) => Promise<unknown>) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <AuditWorkspace organizationId="o1" timezone="America/Argentina/Buenos_Aires" branches={[{ id: 'b1', name: 'Centro' }]} load={load as never}
    loadPeople={vi.fn().mockResolvedValue([{ userId: 'u1', email: 'dueno@uco-demo.test' }])} />
</QueryClientProvider>);

describe('D08 readable audit', () => {
  it('shows what happened and who did it in plain words', async () => {
    view(vi.fn().mockResolvedValue({ items: [event('1', 'sale.confirmed', 'u1'), event('2', 'catalog_item.price_changed', 'u9')], nextCursor: null }));
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Venta confirmada')).toBeDefined();
    expect(within(table).getByText('Precio cambiado')).toBeDefined();
    expect(await within(table).findByText('dueno@uco-demo.test')).toBeDefined();
    expect(within(table).getByText('Otra persona')).toBeDefined();
    expect(within(table).queryByText('u1')).toBeNull();
  });

  it('hides automatic system events unless asked', async () => {
    view(vi.fn().mockResolvedValue({ items: [event('1', 'sale.confirmed', 'u1'), event('2', 'outbox.processed', 'u1')], nextCursor: null }));
    const table = await screen.findByRole('table');
    await within(table).findByText('Venta confirmada');
    expect(within(table).queryByText(/Tarea automática/)).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mostrar también tareas automáticas del sistema' }));
    expect(within(table).getByText(/Tarea automática/)).toBeDefined();
  });

  it('filters by action and person from lists instead of typed codes', async () => {
    const load = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    view(load);
    await waitFor(() => expect(within(screen.getByLabelText('Persona')).getAllByRole('option').map(option => option.textContent))
      .toContain('dueno@uco-demo.test'));
    await userEvent.selectOptions(screen.getByLabelText('Qué pasó'), 'sale.cancelled');
    await userEvent.selectOptions(screen.getByLabelText('Persona'), 'u1');
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar filtros' }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith('o1', expect.objectContaining({ action: 'sale.cancelled', actorUserId: 'u1' })));
    expect(screen.queryByLabelText('ID de usuario actor')).toBeNull();
  });
});
