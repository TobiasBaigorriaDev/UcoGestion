import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { LoginForm, OrganizationSelector } from '../src/features/identity/auth-flow.js';
import { ApiProblemError } from '../src/lib/api/client.js';

afterEach(cleanup);

it('logs in and exposes an accessible failure without showing credentials', async () => {
  const login = vi.fn().mockRejectedValue(new ApiProblemError({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas. Intentá nuevamente.' }));
  render(<LoginForm login={login} onSuccess={vi.fn()} />);
  await userEvent.type(screen.getByLabelText('Correo electrónico'), 'ana@example.com');
  await userEvent.type(screen.getByLabelText('Contraseña'), 'secret-123');
  await userEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
  await waitFor(() => expect(login).toHaveBeenCalledWith('ana@example.com', 'secret-123'));
  expect(screen.getByRole('alert').textContent).toContain('Credenciales inválidas');
  expect(screen.getByRole('alert').textContent).not.toContain('secret-123');
});

it('lists active memberships and confirms a context switch', async () => {
  const select = vi.fn().mockResolvedValue(undefined);
  render(<OrganizationSelector organizations={[{ organizationId: 'a', organizationName: 'Norte', role: 'OWNER' }, { organizationId: 'b', organizationName: 'Sur', role: 'ADMIN' }]} select={select} onSuccess={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /Sur/ }));
  await waitFor(() => expect(select).toHaveBeenCalledWith('b'));
});

it('keeps login and organization selection semantically accessible', async () => {
  const { container, rerender } = render(<LoginForm login={vi.fn()} onSuccess={vi.fn()} />);
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  rerender(<OrganizationSelector organizations={[]} select={vi.fn()} onSuccess={vi.fn()} />);
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});
