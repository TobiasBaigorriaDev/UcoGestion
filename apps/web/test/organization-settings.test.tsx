import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { OrganizationSettings } from '../src/features/identity/organization-settings.js';

afterEach(cleanup);

it('lets an admin save commercial profile with the current version but not timezone', async () => {
  const saveProfile = vi.fn().mockResolvedValue({ profile: { displayName: 'Nuevo' }, version: 4 });
  const saveTimezone = vi.fn();
  render(<OrganizationSettings organizationId="org" role="ADMIN" initial={{ profile: { displayName: 'Anterior' }, timezone: 'America/Argentina/Buenos_Aires', version: 3 }} saveProfile={saveProfile} saveTimezone={saveTimezone} />);
  await userEvent.clear(screen.getByLabelText('Nombre comercial'));
  await userEvent.type(screen.getByLabelText('Nombre comercial'), 'Nuevo');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar perfil' }));
  await waitFor(() => expect(saveProfile).toHaveBeenCalledWith('org', 3, expect.objectContaining({ displayName: 'Nuevo' })));
  expect(screen.queryByRole('button', { name: 'Guardar zona horaria' })).toBeNull();
  expect(saveTimezone).not.toHaveBeenCalled();
});

it('makes a version conflict actionable for owner', async () => {
  const saveTimezone = vi.fn().mockRejectedValue({ code: 'VERSION_CONFLICT', currentVersion: 5 });
  render(<OrganizationSettings organizationId="org" role="OWNER" initial={{ profile: {}, timezone: 'UTC', version: 4 }} saveProfile={vi.fn()} saveTimezone={saveTimezone} />);
  await userEvent.clear(screen.getByLabelText('Zona horaria'));
  await userEvent.type(screen.getByLabelText('Zona horaria'), 'America/Argentina/Mendoza');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar zona horaria' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Volvé a cargar'));
});

it('allows OWNER to change currency with optimistic concurrency', async () => {
  const saveCurrency = vi.fn().mockResolvedValue({ currency: 'USD', version: 5 });
  render(
    <OrganizationSettings
      organizationId="org"
      role="OWNER"
      initial={{ profile: {}, timezone: 'UTC', currency: 'ARS', version: 4 }}
      saveProfile={vi.fn()}
      saveTimezone={vi.fn()}
      saveCurrency={saveCurrency}
    />,
  );
  expect(screen.getByLabelText('Moneda base')).toBeTruthy();
  await userEvent.clear(screen.getByLabelText('Moneda base'));
  await userEvent.type(screen.getByLabelText('Moneda base'), 'USD');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar moneda' }));
  expect(saveCurrency).toHaveBeenCalledWith('org', 4, 'USD');
  expect(await screen.findByText(/Moneda base actualizada/i)).toBeTruthy();
});

it('disallows non-owner roles from changing currency', async () => {
  render(
    <OrganizationSettings
      organizationId="org"
      role="ADMIN"
      initial={{ profile: {}, timezone: 'UTC', currency: 'ARS', version: 4 }}
      saveProfile={vi.fn()}
      saveTimezone={vi.fn()}
    />,
  );
  expect(screen.getByLabelText('Moneda base')).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: 'Guardar moneda' })).toBeNull();
});

it('displays differentiated D01 error messages for currency locks', async () => {
  const saveCurrencyHistory = vi.fn().mockRejectedValue({
    code: 'CURRENCY_LOCKED_BY_HISTORY',
    message: 'Moneda bloqueada por historial',
  });
  const saveCurrencyOffline = vi.fn().mockRejectedValue({
    code: 'CURRENCY_LOCKED_BY_OFFLINE_UNCERTAINTY',
    message: 'Moneda bloqueada por offline',
  });
  const saveCurrencyPerm = vi.fn().mockRejectedValue({
    code: 'CURRENCY_PERMANENTLY_LOCKED',
    message: 'Moneda bloqueada permanentemente',
  });

  const { unmount: unmount1 } = render(
    <OrganizationSettings
      organizationId="org"
      role="OWNER"
      initial={{ profile: {}, timezone: 'UTC', currency: 'ARS', version: 4 }}
      saveCurrency={saveCurrencyHistory}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Guardar moneda' }));
  expect(await screen.findByText(/organización ya registró operaciones comerciales o movimientos/i)).toBeTruthy();
  unmount1();

  const { unmount: unmount2 } = render(
    <OrganizationSettings
      organizationId="org"
      role="OWNER"
      initial={{ profile: {}, timezone: 'UTC', currency: 'ARS', version: 4 }}
      saveCurrency={saveCurrencyOffline}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Guardar moneda' }));
  expect(await screen.findByText(/dispositivos offline con autorizaciones o posibles operaciones pendientes/i)).toBeTruthy();
  unmount2();

  const { unmount: unmount3 } = render(
    <OrganizationSettings
      organizationId="org"
      role="OWNER"
      initial={{ profile: {}, timezone: 'UTC', currency: 'ARS', version: 4 }}
      saveCurrency={saveCurrencyPerm}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Guardar moneda' }));
  expect(await screen.findByText(/bloqueada permanentemente debido a que un dispositivo irrecuperable/i)).toBeTruthy();
  unmount3();
});

