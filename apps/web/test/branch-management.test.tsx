import axe from 'axe-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { BranchManagement } from '../src/features/identity/branch-management.js';

afterEach(cleanup);

it('requires explicit confirmation after authoritative blocker preview', async () => {
  const blockers = vi.fn().mockResolvedValue({ sessions: '0', pending: '0', conflicts: '0', uncertainty: '0' });
  const deactivate = vi.fn().mockResolvedValue({ id: 'branch-a', name: 'Principal', status: 'INACTIVE', version: 2 });
  const reload = vi.fn();
  render(<BranchManagement organizationId="org" data={{ actorRole: 'OWNER', branches: [branch] }} onReload={reload} onBlockers={blockers} onDeactivate={deactivate} />);
  await userEvent.click(screen.getByRole('button', { name: 'Revisar desactivación de Principal' }));
  const button = await screen.findByRole('button', { name: 'Desactivar Principal' });
  expect(button).toHaveProperty('disabled', true);
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(button);
  await waitFor(() => expect(deactivate).toHaveBeenCalledWith('org', 'branch-a', 1));
  expect(reload).toHaveBeenCalled();
});

it('shows actionable blockers and hides confirmation while uncertainty persists', async () => {
  const { container } = render(<BranchManagement organizationId="org" data={{ actorRole: 'OWNER', branches: [branch] }} onReload={vi.fn()}
    onBlockers={vi.fn().mockResolvedValue({ sessions: '2', pending: '3', conflicts: '1', uncertainty: '1' })} />);
  await userEvent.click(screen.getByRole('button', { name: 'Revisar desactivación de Principal' }));
  expect(await screen.findByText(/Incertidumbre offline: 1/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Revisar sesiones de caja' })).toBeTruthy();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

const branch = { id: 'branch-a', name: 'Principal', status: 'ACTIVE' as const, version: 1 };

it('lets OWNER create a branch and reports its new context', async () => {
  const create = vi.fn().mockResolvedValue({ id: 'branch-b', name: 'Depósito', status: 'ACTIVE', version: 1 });
  const reload = vi.fn();
  render(<BranchManagement organizationId="org" data={{ actorRole: 'OWNER', branches: [branch] }} onCreate={create} onReload={reload} />);
  await userEvent.type(screen.getByLabelText('Nombre de la sucursal'), 'Depósito');
  await userEvent.click(screen.getByRole('button', { name: 'Crear sucursal' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith('org', 'Depósito'));
  expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('Depósito'));
  expect(reload).toHaveBeenCalled();
});

it('shows assigned branches to ADMIN without offering creation', async () => {
  const create = vi.fn();
  const { container } = render(<BranchManagement organizationId="org" data={{ actorRole: 'ADMIN', branches: [branch] }} onCreate={create} onReload={vi.fn()} />);
  expect(screen.getByText('Principal')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Crear sucursal' })).toBeNull();
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});
