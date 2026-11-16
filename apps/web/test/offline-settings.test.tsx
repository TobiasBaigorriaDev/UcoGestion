import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { OfflineSettings } from '../src/features/offline/offline-settings';

afterEach(cleanup);
it('changes the PIN with confirmation, clears sensitive inputs and keeps pending detail', async () => {
  const changePin = vi.fn().mockResolvedValue(undefined);
  render(<OfflineSettings role="OWNER" configured unlock={vi.fn().mockResolvedValue(status)} lock={vi.fn()}
    authorize={vi.fn()} refresh={vi.fn()} sync={vi.fn()} changePin={changePin} />);
  await userEvent.type(screen.getByLabelText('PIN offline'), 'original-pin');
  await userEvent.click(screen.getByRole('button', { name: 'Desbloquear mi identidad' }));
  await screen.findByText('own-id');
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar PIN offline' }));
  await userEvent.type(screen.getByLabelText('PIN actual'), 'original-pin');
  await userEvent.type(screen.getByLabelText('Nuevo PIN'), 'replacement-pin');
  await userEvent.type(screen.getByLabelText('Confirmar nuevo PIN'), 'different-pin');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar nuevo PIN' }));
  await screen.findByText('Los PIN nuevos no coinciden.');
  expect(screen.getByText('Revisá los campos para cambiar tu PIN.').closest('[role="alert"]')).toBe(document.activeElement);
  expect(screen.getByRole('link', { name: 'Confirmar nuevo PIN: Los PIN nuevos no coinciden.' }).getAttribute('href')).toBe('#offline-change-confirmation');
  expect(changePin).not.toHaveBeenCalled();
  await userEvent.clear(screen.getByLabelText('Confirmar nuevo PIN'));
  await userEvent.type(screen.getByLabelText('Confirmar nuevo PIN'), 'replacement-pin');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar nuevo PIN' }));
  await screen.findByText('PIN offline actualizado. Tus datos y pendientes se conservaron.');
  expect(changePin).toHaveBeenCalledWith('original-pin', 'replacement-pin');
  expect(screen.queryByLabelText('PIN actual')).toBeNull();
  expect(screen.getByText('own-id')).toBeTruthy();
});

it('locks private detail and reports an incorrect current PIN without leaking internal errors', async () => {
  const lock = vi.fn();
  render(<OfflineSettings role="OWNER" configured unlock={vi.fn().mockResolvedValue(status)} lock={lock}
    authorize={vi.fn()} refresh={vi.fn()} sync={vi.fn()} changePin={vi.fn().mockRejectedValue(new Error('PIN incorrecto.'))} />);
  await userEvent.type(screen.getByLabelText('PIN offline'), 'original-pin');
  await userEvent.click(screen.getByRole('button', { name: 'Desbloquear mi identidad' }));
  await screen.findByText('own-id');
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar PIN offline' }));
  await userEvent.type(screen.getByLabelText('PIN actual'), 'incorrect-pin');
  await userEvent.type(screen.getByLabelText('Nuevo PIN'), 'replacement-pin');
  await userEvent.type(screen.getByLabelText('Confirmar nuevo PIN'), 'replacement-pin');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar nuevo PIN' }));
  await screen.findByText('PIN actual incorrecto. Tus datos y pendientes siguen protegidos.');
  expect(screen.queryByText('own-id')).toBeNull();
  expect(lock).toHaveBeenCalled();
});
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
  expect(screen.getByRole('alert').textContent).toContain('No pudimos sincronizar');
  expect(screen.getByRole('alert').textContent).not.toContain('Verificá el PIN');
  expect(screen.getByText('own-id')).toBeTruthy();
  expect(screen.queryByText('secret payload')).toBeNull();
});
