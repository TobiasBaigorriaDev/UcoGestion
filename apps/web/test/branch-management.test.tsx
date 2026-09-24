import axe from 'axe-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { BranchManagement } from '../src/features/identity/branch-management.js';

afterEach(cleanup);

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
