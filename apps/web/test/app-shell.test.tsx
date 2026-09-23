import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../src/components/app-shell.js';

const organizations = [
  { id: 'org-a', name: 'Almacén Norte', branches: [{ id: 'branch-a', name: 'Centro' }] },
  { id: 'org-b', name: 'Almacén Sur', branches: [{ id: 'branch-b', name: 'Terminal' }] },
] as const;

afterEach(cleanup);

describe('AppShell', () => {
  it('shows active organization and only its branches with accessible navigation', async () => {
    const onOrganizationChange = vi.fn();
    const onBranchChange = vi.fn();
    const { container } = render(
      <AppShell
        organizations={organizations}
        activeOrganizationId="org-a"
        activeBranchId="branch-a"
        onOrganizationChange={onOrganizationChange}
        onBranchChange={onBranchChange}
        navigation={[{ href: '/catalog', label: 'Catálogo' }]}
        currentPath="/catalog"
      >
        <h1>Catálogo</h1>
      </AppShell>,
    );

    expect(screen.getByRole('combobox', { name: 'Organización activa' })).toHaveProperty('value', 'org-a');
    expect(screen.getByRole('combobox', { name: 'Sucursal activa' })).toHaveProperty('value', 'branch-a');
    expect(screen.queryByRole('option', { name: 'Terminal' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Catálogo' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('main').getAttribute('id')).toBe('contenido-principal');
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('lets keyboard users switch organization and branch context', async () => {
    const user = userEvent.setup();
    const onOrganizationChange = vi.fn();
    const onBranchChange = vi.fn();
    const { rerender } = render(
      <AppShell organizations={organizations} activeOrganizationId="org-a" activeBranchId="branch-a"
        onOrganizationChange={onOrganizationChange} onBranchChange={onBranchChange} navigation={[]} currentPath="/">
        <p>Contenido</p>
      </AppShell>,
    );

    await user.tab();
    expect(screen.getByRole('link', { name: 'Ir al contenido principal' })).toBe(document.activeElement);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Organización activa' }), 'org-b');
    expect(onOrganizationChange).toHaveBeenCalledWith('org-b');

    rerender(
      <AppShell organizations={organizations} activeOrganizationId="org-b" activeBranchId={null}
        onOrganizationChange={onOrganizationChange} onBranchChange={onBranchChange} navigation={[]} currentPath="/">
        <p>Contenido</p>
      </AppShell>,
    );
    expect(screen.queryByRole('option', { name: 'Centro' })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sucursal activa' }), 'branch-b');
    expect(onBranchChange).toHaveBeenCalledWith('branch-b');
  });
});
