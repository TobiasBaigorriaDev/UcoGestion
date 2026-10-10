import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { OfflineSettings } from '../src/features/offline/offline-settings';

afterEach(cleanup);
it('refreshes own pending state after automatic signed delivery without requesting another delivery', async () => {
  const sync = vi.fn(), readStatus = vi.fn().mockResolvedValue({ ...status, pending: [] });
  render(<OfflineSettings role="OWNER" configured unlock={vi.fn().mockResolvedValue(status)} lock={vi.fn()} authorize={vi.fn()} refresh={vi.fn()} sync={sync} readStatus={readStatus} />);
  await userEvent.type(screen.getByLabelText('PIN offline'), 'offline-pin');
  await userEvent.click(screen.getByRole('button', { name: 'Desbloquear mi identidad' }));
  await screen.findByText('own-id');
  expect(screen.getByText(new Date(status.pending[0]!.occurredAt).toLocaleString('es-AR',{timeZone:status.timezone}))).toBeTruthy();
  fireEvent(window, new Event('uco:delivery-state'));
  await screen.findByText('No tenés operaciones pendientes.');
  expect(sync).not.toHaveBeenCalled();
});
const status = { timezone: 'Pacific/Auckland', expired: false, expiresAt: '2026-10-10T12:00:00Z', lastSyncAt: '2026-10-07T12:00:00Z',
  pending: [{ id: 'own-id', kind: 'sale-confirm', sequence: '7', occurredAt: '2026-10-07T12:10:00Z' }] };
it('T220A keeps detail hidden until PIN unlock and clears it immediately when locked', async () => {
  const unlock = vi.fn().mockResolvedValue(status), lock = vi.fn();
  render(<OfflineSettings role="CASHIER" configured unlock={unlock} lock={lock} authorize={vi.fn()} refresh={vi.fn()} sync={vi.fn().mockResolvedValue(status)} />);
  expect(screen.queryByText('own-id')).toBeNull();
  await userEvent.type(screen.getByLabelText('PIN offline'), 'offline-pin');
  await userEvent.click(screen.getByRole('button', { name: 'Desbloquear mi identidad' }));
  await waitFor(() => expect(screen.getByText('own-id')).toBeTruthy());
  expect(unlock).toHaveBeenCalledWith('offline-pin');
  expect(screen.queryByLabelText('PIN offline')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Bloquear datos offline' }));
  expect(lock).toHaveBeenCalled();
  expect(screen.queryByText('own-id')).toBeNull();
  expect((screen.getByLabelText('PIN offline') as HTMLInputElement).value).toBe('');
});
it('T220A displays expired authorization without enabling offline creation and preserves detail on recoverable sync error', async () => {
  render(<OfflineSettings role="OWNER" configured unlock={vi.fn().mockResolvedValue({ ...status, expired: true })}
    lock={vi.fn()} authorize={vi.fn()} refresh={vi.fn()} sync={vi.fn().mockRejectedValue(new Error('secret payload'))} />);
  await userEvent.type(screen.getByLabelText('PIN offline'), 'offline-pin');
  await userEvent.click(screen.getByRole('button', { name: 'Desbloquear mi identidad' }));
  await screen.findByText(/Autorización vencida/);
  await userEvent.click(screen.getByRole('button', { name: 'Sincronizar mis pendientes' }));
  await screen.findByText(/Los pendientes siguen protegidos/);
  expect(screen.getByText('own-id')).toBeTruthy();
  expect(screen.queryByText('secret payload')).toBeNull();
});
