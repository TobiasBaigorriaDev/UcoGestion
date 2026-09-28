import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';

import { AuditWorkspace } from '../src/features/insights/audit-workspace';

afterEach(cleanup);
describe('auditoría', () => {
  it('filtra eventos y permite cargar la siguiente página', async () => {
    const load = vi.fn().mockResolvedValueOnce({ items: [{ id: 'e1', action: 'sale.confirmed',
      actorUserId: 'u1', entityType: 'sale', entityId: 's1', branchId: 'b1',
      occurredAt: '2026-01-01T12:00:00.000Z' }], nextCursor: 'next' })
      .mockResolvedValue({ items: [], nextCursor: null });
    const { container } = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuditWorkspace organizationId="o1" timezone="America/Argentina/Buenos_Aires" branches={[{ id: 'b1', name: 'Centro' }]} load={load} />
    </QueryClientProvider>);
    expect(await screen.findByText('sale.confirmed')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Cargar más eventos' }));
    await waitFor(() => expect(load).toHaveBeenCalledWith('o1', expect.objectContaining({ cursor: 'next' })));
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
