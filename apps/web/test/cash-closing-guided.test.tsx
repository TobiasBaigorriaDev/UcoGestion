import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CashSession } from '../src/features/cash/cash-api';
import { CashClosing } from '../src/features/cash/cash-closing';

afterEach(cleanup);
const org = '00000000-0000-4000-8000-000000000001', device = '00000000-0000-4000-8000-000000000003';
const id = '00000000-0000-4000-8000-000000000005', attempt = '00000000-0000-4000-8000-000000000007';
const base: CashSession = { id, cashRegisterId: org, registerName: 'Mostrador', deviceId: device, status: 'CLOSING',
  closeAttemptId: attempt, openingCash: '1000.00', expectedCash: '22300.00', currencyCode: 'ARS', openedAt: '2026-10-07T00:00:00Z' };
const view = (session: CashSession, command = vi.fn()) => render(<CashClosing organizationId={org} actorUserId={org} role="CASHIER"
  session={session} localDeviceId={device} onCommand={command} onPrepare={vi.fn()} onAbortRelease={vi.fn()} onFinish={vi.fn()} onReload={vi.fn()} />);

describe('D08 guided cash closing', () => {
  it('explains closing as steps before it starts', () => {
    view({ ...base, status: 'OPEN', closeAttemptId: undefined });
    const steps = screen.getByRole('list', { name: 'Pasos para cerrar la caja' });
    expect(within(steps).getAllByRole('listitem').map(item => item.getAttribute('data-state'))).toEqual(['current', 'pending', 'pending', 'pending']);
    expect(screen.getByRole('button', { name: 'Empezar el cierre' })).toBeDefined();
  });

  it('asks to review pending sales before counting, with a way back', () => {
    view(base);
    const steps = screen.getByRole('list', { name: 'Pasos para cerrar la caja' });
    expect(within(steps).getAllByRole('listitem').map(item => item.getAttribute('data-state'))).toEqual(['done', 'current', 'pending', 'pending']);
    expect(screen.getByRole('button', { name: 'Revisar ventas pendientes' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Cancelar el cierre' })).toBeDefined();
    expect(screen.queryByRole('textbox', { name: 'Efectivo contado' })).toBeNull();
  });

  it('shows what should be in the drawer and whether money is short or over as it is typed', async () => {
    view({ ...base, finalSync: { ready: true, expectedCash: '22300.00' } });
    expect(screen.getByText('$ 22.300,00')).toBeDefined();
    const counted = screen.getByRole('textbox', { name: 'Efectivo contado' });
    await userEvent.type(counted, '22.000');
    expect(screen.getByText('Faltan $ 300,00')).toBeDefined();
    await userEvent.clear(counted);
    await userEvent.type(counted, '22.300,50');
    expect(screen.getByText('Sobran $ 0,50')).toBeDefined();
    await userEvent.clear(counted);
    await userEvent.type(counted, '22300');
    expect(screen.getByText('El efectivo coincide')).toBeDefined();
  });

  it('confirms with the counted amount in canonical form and summarizes the closed drawer', async () => {
    const command = vi.fn().mockResolvedValue({ cashSessionId: id, closeAttemptId: attempt, closureId: org, status: 'CLOSED',
      expectedCash: '22300.00', countedCash: '22300.00', difference: '0.00' });
    view({ ...base, finalSync: { ready: true, expectedCash: '22300.00' } }, command);
    await userEvent.type(screen.getByRole('textbox', { name: 'Efectivo contado' }), '22.300');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar cierre' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith('close', expect.objectContaining({ countedCash: '22300.00', expectedCash: '22300.00' }), expect.any(String)));
    const summary = await screen.findByRole('region', { name: 'Caja cerrada' });
    expect(within(summary).getByText('Contado').nextElementSibling?.textContent).toBe('$ 22.300,00');
    expect(within(summary).getByText('Diferencia').nextElementSibling?.textContent).toBe('$ 0,00');
  });
});
