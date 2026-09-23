import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { PlatformOnboarding } from '../src/features/identity/platform-onboarding.js';
import { ApiProblemError } from '../src/lib/api/client.js';

afterEach(cleanup);

it('submits organization, first branch and owner together and confirms persisted result', async () => {
  const provision = vi.fn().mockResolvedValue({ organizationId: 'org', branchId: 'branch', userId: 'owner', membershipId: 'membership' });
  render(<PlatformOnboarding provision={provision} />);
  await userEvent.type(screen.getByLabelText('Nombre de la organización'), 'Almacén');
  await userEvent.type(screen.getByLabelText('Primera sucursal'), 'Centro');
  await userEvent.type(screen.getByLabelText('Correo del OWNER'), 'owner@example.com');
  await userEvent.type(screen.getByLabelText('Contraseña inicial del OWNER'), 'password-12345');
  await userEvent.clear(screen.getByLabelText('Zona horaria'));
  await userEvent.type(screen.getByLabelText('Zona horaria'), 'America/Argentina/Mendoza');
  await userEvent.click(screen.getByRole('button', { name: 'Crear organización' }));
  await waitFor(() => expect(provision).toHaveBeenCalledWith(expect.objectContaining({ organizationName: 'Almacén', firstBranchName: 'Centro', ownerEmail: 'owner@example.com', timezone: 'America/Argentina/Mendoza' })));
  expect(screen.getByRole('status').textContent).toContain('creada');
  expect(screen.queryByText('password-12345')).toBeNull();
});

it('explains rollback when provisioning fails', async () => {
  render(<PlatformOnboarding provision={vi.fn().mockRejectedValue(new ApiProblemError({ status: 400, code: 'BAD_REQUEST', message: 'Invalid' }))} />);
  await userEvent.type(screen.getByLabelText('Nombre de la organización'), 'Almacén');
  await userEvent.type(screen.getByLabelText('Primera sucursal'), 'Centro');
  await userEvent.type(screen.getByLabelText('Correo del OWNER'), 'owner@example.com');
  await userEvent.type(screen.getByLabelText('Contraseña inicial del OWNER'), 'password-12345');
  await userEvent.click(screen.getByRole('button', { name: 'Crear organización' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('No se creó'));
});

it('does not claim rollback on an uncertain network result and keeps the request key', async () => {
  const provision = vi.fn()
    .mockRejectedValueOnce(new ApiProblemError({ status: 0, code: 'NETWORK_ERROR', message: 'Network failed' }))
    .mockResolvedValueOnce({ organizationId: 'org', branchId: 'branch', userId: 'owner', membershipId: 'membership' });
  render(<PlatformOnboarding provision={provision} />);
  await userEvent.type(screen.getByLabelText('Nombre de la organización'), 'Almacén');
  await userEvent.type(screen.getByLabelText('Primera sucursal'), 'Centro');
  await userEvent.type(screen.getByLabelText('Correo del OWNER'), 'owner@example.com');
  await userEvent.type(screen.getByLabelText('Contraseña inicial del OWNER'), 'password-12345');
  await userEvent.click(screen.getByRole('button', { name: 'Crear organización' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('No pudimos confirmar'));
  await userEvent.click(screen.getByRole('button', { name: 'Crear organización' }));
  await waitFor(() => expect(provision).toHaveBeenCalledTimes(2));
  expect(provision.mock.calls[1]?.[0].requestId).toBe(provision.mock.calls[0]?.[0].requestId);
});
