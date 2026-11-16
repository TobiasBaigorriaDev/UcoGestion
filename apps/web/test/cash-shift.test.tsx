import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CashOperations, type CashWorkspaceData } from '../src/features/cash/cash-operations';

afterEach(cleanup);
const org = '00000000-0000-4000-8000-000000000001', branch = '00000000-0000-4000-8000-000000000002';
const device = '00000000-0000-4000-8000-000000000003', register = '00000000-0000-4000-8000-000000000004';
const session = '00000000-0000-4000-8000-000000000005';
const idle: CashWorkspaceData = { actorUserId: org, registers: [{ id: register, name: 'Mostrador', available: true }],
  devices: [{ id: device, status: 'ACTIVE' }], sessions: [] };
const open: CashWorkspaceData = { ...idle, registers: [{ id: register, name: 'Mostrador', available: false }],
  sessions: [{ id: session, cashRegisterId: register, registerName: 'Mostrador', deviceId: device, status: 'OPEN',
    openingCash: '1500.00', expectedCash: '22300.50', currencyCode: 'ARS', openedAt: '2026-10-07T12:00:00Z' }] };

describe('D08 cash shift', () => {
  it('summarizes the open shift with the expected cash in pesos', () => {
    render(<CashOperations organizationId={org} branchId={branch} role="CASHIER" data={open} localDeviceId={device}
      onCommand={vi.fn()} onReload={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Turno de caja' })).toBeDefined();
    const summary = screen.getByRole('region', { name: 'Turno actual' });
    expect(within(summary).getByText('$ 22.300,50')).toBeDefined();
    expect(within(summary).getByText('Abierto')).toBeDefined();
    expect(within(summary).getByText(/Inicial \$ 1\.500,00/)).toBeDefined();
  });

  it('opens a shift with an amount typed in Argentine format', async () => {
    const submit = vi.fn().mockResolvedValue({ id: session });
    render(<CashOperations organizationId={org} branchId={branch} role="CASHIER" data={idle} localDeviceId={device}
      onCommand={submit} onReload={vi.fn()} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Efectivo inicial' }), '1.500,50');
    await userEvent.click(screen.getByRole('button', { name: 'Abrir turno' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('open',
      { branchId: branch, cashRegisterId: register, deviceId: device, openingCash: '1500.50' }, expect.any(String)));
    expect(screen.getByRole('status').textContent).toContain('Turno abierto');
  });

  it('records a movement typed in Argentine format', async () => {
    const submit = vi.fn().mockResolvedValue({ id: org });
    render(<CashOperations organizationId={org} branchId={branch} role="CASHIER" data={open} localDeviceId={device}
      onCommand={submit} onReload={vi.fn()} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Importe' }), '2.000');
    await userEvent.type(screen.getByRole('textbox', { name: 'Motivo' }), 'Pago a proveedor');
    await userEvent.click(screen.getByRole('button', { name: 'Registrar movimiento' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('manual-deposits',
      { cashSessionId: session, deviceId: device, amount: '2000.00', reason: 'Pago a proveedor' }, expect.any(String)));
  });

  it('gives owners a way to enable this device instead of a dead end', () => {
    render(<CashOperations organizationId={org} branchId={branch} role="OWNER" data={idle} localDeviceId={undefined}
      onCommand={vi.fn()} onReload={vi.fn()} />);
    const notice = screen.getByRole('region', { name: 'Este equipo no está habilitado para la caja' });
    expect(within(notice).getByRole('link', { name: 'Habilitar este equipo' }).getAttribute('href')).toBe('/workspace/offline');
    expect(screen.queryByRole('button', { name: 'Abrir turno' })).toBeNull();
  });

  it('tells cashiers who can enable the device', () => {
    render(<CashOperations organizationId={org} branchId={branch} role="CASHIER" data={idle} localDeviceId={undefined}
      onCommand={vi.fn()} onReload={vi.fn()} />);
    const notice = screen.getByRole('region', { name: 'Este equipo no está habilitado para la caja' });
    expect(notice.textContent).toContain('dueño o a un administrador');
    expect(within(notice).queryByRole('link')).toBeNull();
  });
});
