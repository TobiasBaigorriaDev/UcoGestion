import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShell, type NavigationGroup } from '../src/components/app-shell.js';

const organizations = [
  { id: 'org-a', name: 'Almacén Norte', branches: [{ id: 'branch-a', name: 'Centro' }, { id: 'branch-c', name: 'Costa' }] },
  { id: 'org-b', name: 'Almacén Sur', branches: [{ id: 'branch-b', name: 'Terminal' }] },
] as const;
const single = [{ id: 'org-a', name: 'Almacén Don Pedro', branches: [{ id: 'branch-a', name: 'Local principal' }] }] as const;
const groups: NavigationGroup[] = [
  { label: 'Inicio', items: [{ href: '/workspace', label: 'Inicio', icon: 'home' }] },
  { label: 'Vender', items: [{ href: '/workspace/pos', label: 'Mostrador', icon: 'counter' }, { href: '/workspace/sales', label: 'Ventas', icon: 'receipt' }] },
  { label: 'Caja', items: [{ href: '/workspace/cash-sessions', label: 'Turno de caja', icon: 'wallet' }] },
];
const primary = [groups[0]?.items[0], groups[1]?.items[0], groups[2]?.items[0]].filter(item => item !== undefined);

afterEach(cleanup);

describe('AppShell (D08 grouped navigation)', () => {
  it('groups sections by task and marks the current page and its group', () => {
    render(<AppShell organizations={organizations} activeOrganizationId="org-a" activeBranchId="branch-a"
      onOrganizationChange={vi.fn()} onBranchChange={vi.fn()} navigation={groups} currentPath="/workspace/sales">
      <h1>Ventas</h1></AppShell>);
    const nav = screen.getByRole('navigation', { name: 'Navegación principal' });
    const sell = within(nav).getByRole('list', { name: 'Vender' });
    expect(within(sell).getByRole('link', { name: 'Ventas' }).getAttribute('aria-current')).toBe('page');
    expect(within(sell).getByRole('link', { name: 'Mostrador' }).getAttribute('aria-current')).toBeNull();
    expect(within(nav).getByRole('list', { name: 'Caja' })).toBeDefined();
  });

  it('offers a mobile bar with the daily destinations and a button for every section', async () => {
    const user = userEvent.setup();
    render(<AppShell organizations={organizations} activeOrganizationId="org-a" activeBranchId="branch-a"
      onOrganizationChange={vi.fn()} onBranchChange={vi.fn()} navigation={groups} primaryNavigation={primary}
      currentPath="/workspace/pos"><h1>Mostrador</h1></AppShell>);
    const bar = screen.getByRole('navigation', { name: 'Accesos principales' });
    expect(within(bar).getByRole('link', { name: 'Mostrador' }).getAttribute('aria-current')).toBe('page');
    const more = within(bar).getByRole('button', { name: 'Ver todas las secciones' });
    const nav = screen.getByRole('navigation', { name: 'Navegación principal' });
    expect(more.getAttribute('aria-controls')).toBe(nav.id);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await user.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(nav.getAttribute('data-open')).toBe('true');
    await user.keyboard('{Escape}');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(more);
  });

  it('shows the business and branch as text when there is nothing to choose', () => {
    render(<AppShell organizations={single} activeOrganizationId="org-a" activeBranchId="branch-a"
      onOrganizationChange={vi.fn()} onBranchChange={vi.fn()} navigation={groups} currentPath="/workspace">
      <h1>Inicio</h1></AppShell>);
    expect(screen.queryByRole('combobox')).toBeNull();
    const context = screen.getByRole('group', { name: 'Contexto de trabajo' });
    expect(within(context).getByText('Almacén Don Pedro')).toBeDefined();
    expect(within(context).getByText('Local principal')).toBeDefined();
  });

  it('lets keyboard users switch organization and branch when there are alternatives', async () => {
    const user = userEvent.setup();
    const onOrganizationChange = vi.fn();
    const onBranchChange = vi.fn();
    const { container } = render(<AppShell organizations={organizations} activeOrganizationId="org-a" activeBranchId="branch-a"
      onOrganizationChange={onOrganizationChange} onBranchChange={onBranchChange} navigation={groups} currentPath="/workspace">
      <h1>Inicio</h1></AppShell>);
    await user.tab();
    expect(screen.getByRole('link', { name: 'Ir al contenido principal' })).toBe(document.activeElement);
    expect(screen.queryByRole('option', { name: 'Terminal' })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Organización activa' }), 'org-b');
    expect(onOrganizationChange).toHaveBeenCalledWith('org-b');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sucursal activa' }), 'branch-c');
    expect(onBranchChange).toHaveBeenCalledWith('branch-c');
    expect(screen.getByRole('main').getAttribute('id')).toBe('contenido-principal');
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('still accepts a flat list of links', () => {
    render(<AppShell organizations={organizations} activeOrganizationId="org-a" activeBranchId="branch-a"
      onOrganizationChange={vi.fn()} onBranchChange={vi.fn()} navigation={[{ href: '/catalog', label: 'Catálogo' }]}
      currentPath="/catalog"><h1>Catálogo</h1></AppShell>);
    expect(screen.getByRole('link', { name: 'Catálogo' }).getAttribute('aria-current')).toBe('page');
  });
});
