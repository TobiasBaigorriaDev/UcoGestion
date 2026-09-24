import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { ForgotPasswordForm, ResetPasswordForm, AcceptInvitationForm } from '../src/features/identity/account-recovery.js';
import { ApiProblemError } from '../src/lib/api/client.js';

afterEach(cleanup);

it('shows the same non-enumerating confirmation after a recovery request', async () => {
  const request = vi.fn().mockResolvedValue(undefined);
  render(<ForgotPasswordForm request={request} />);
  await userEvent.type(screen.getByLabelText('Correo electrónico'), 'ana@example.com');
  await userEvent.click(screen.getByRole('button', { name: 'Enviar enlace' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('ana@example.com'));
  expect(screen.getByRole('status').textContent).toContain('Si existe una cuenta');
});

it('resets a password without exposing the token and handles an invalid link', async () => {
  const reset = vi.fn().mockRejectedValue(new ApiProblemError({ status: 400, code: 'INVALID_RESET_TOKEN', message: 'Enlace inválido' }));
  render(<ResetPasswordForm token="secret-token" resetPassword={reset} />);
  await userEvent.type(screen.getByLabelText('Nueva contraseña'), 'correct-password-123');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar contraseña' }));
  await waitFor(() => expect(reset).toHaveBeenCalledWith('secret-token', 'correct-password-123'));
  expect(screen.getByRole('alert').textContent).toContain('Solicitá otro enlace');
  expect(document.body.textContent).not.toContain('secret-token');
});

it('accepts an invitation with a new password and keeps the form accessible', async () => {
  const accept = vi.fn().mockResolvedValue(undefined);
  const { container } = render(<AcceptInvitationForm token="invite-token" accept={accept} />);
  await userEvent.type(screen.getByLabelText('Crear contraseña'), 'correct-password-123');
  await userEvent.click(screen.getByRole('button', { name: 'Aceptar invitación' }));
  await waitFor(() => expect(accept).toHaveBeenCalledWith('invite-token', 'correct-password-123'));
  expect(screen.getByRole('status').textContent).toContain('Invitación aceptada');
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

it('accepts an invitation for an existing account without changing its password', async () => {
  const accept = vi.fn().mockResolvedValue(undefined);
  render(<AcceptInvitationForm token="invite-token" accept={accept} />);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Ya tengo una cuenta' }));
  expect(screen.queryByLabelText('Crear contraseña')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Aceptar con mi cuenta' }));
  await waitFor(() => expect(accept).toHaveBeenCalledWith('invite-token'));
});
