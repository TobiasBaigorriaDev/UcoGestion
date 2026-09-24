import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import axe from 'axe-core';

import { UserManagement } from '../src/features/identity/user-management.js';

afterEach(cleanup);

const branch = { id: 'branch-a', name: 'Principal', status: 'ACTIVE' as const };
const employee = { id: 'member-a', email: 'ana@example.com', role: 'EMPLOYEE' as const, status: 'ACTIVE' as const, version: 3, branchIds: ['branch-a'], hasOutsideScope: false };

it('limits ADMIN to non-owner roles and submits the version being edited', async () => {
  const changeRole = vi.fn().mockResolvedValue({ role: 'CASHIER', version: 4 });
  render(<UserManagement organizationId="org" data={{ actorRole: 'ADMIN', branches: [branch], memberships: [employee], invitations: [] }}
    onChangeRole={changeRole} onInvite={vi.fn()} onRevokeInvitation={vi.fn()} onReload={vi.fn()} />);
  expect(screen.queryByRole('option', { name: 'Propietario' })).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText('Rol de ana@example.com'), 'CASHIER');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios de ana@example.com' }));
  await waitFor(() => expect(changeRole).toHaveBeenCalledWith('org', 'member-a', 3, 'CASHIER', ['branch-a']));
});

it('shows version conflicts with a reload action', async () => {
  render(<UserManagement organizationId="org" data={{ actorRole: 'OWNER', branches: [branch], memberships: [employee], invitations: [] }}
    onChangeRole={vi.fn().mockRejectedValue({ code: 'MEMBERSHIP_VERSION_CONFLICT' })} onInvite={vi.fn()} onRevokeInvitation={vi.fn()} onReload={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios de ana@example.com' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Volvé a cargar'));
});

it('provides labeled controls without structural accessibility violations', async () => {
  const { container } = render(<UserManagement organizationId="org" data={{ actorRole: 'OWNER', branches: [branch], memberships: [employee], invitations: [] }}
    onChangeRole={vi.fn()} onInvite={vi.fn()} onRevokeInvitation={vi.fn()} onReload={vi.fn()} />);
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

it('lets a manager resend an expired invitation and announces the old-link invalidation', async () => {
  const resend = vi.fn().mockResolvedValue({ invitationId: 'invite-a', expiresAt: '2026-10-01T00:00:00.000Z' });
  render(<UserManagement organizationId="org" data={{ actorRole: 'OWNER', branches: [branch], memberships: [], invitations: [{ id: 'invite-a', email: 'ana@example.com', role: 'EMPLOYEE', status: 'EXPIRED', expiresAt: '2026-09-01T00:00:00.000Z', branchIds: ['branch-a'] }] }}
    onResendInvitation={resend} onReload={vi.fn()} />);
  expect(screen.getByText('Empleado · Vencida')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Reenviar invitación a ana@example.com' }));
  await waitFor(() => expect(resend).toHaveBeenCalledWith('org', 'invite-a'));
  expect(screen.getByRole('status').textContent).toContain('El enlace anterior dejó de ser válido');
});
