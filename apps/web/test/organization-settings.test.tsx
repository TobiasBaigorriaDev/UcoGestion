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
