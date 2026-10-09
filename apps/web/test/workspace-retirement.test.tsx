import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Workspace } from '../src/features/identity/workspace';
import { useIdentityContext } from '../src/features/identity/identity-context';
const org = '11111111-1111-4111-8111-111111111111';
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); useIdentityContext.getState().setActiveOrganizationId(null); });
it('removes the private workspace and remote cache after retirement in another tab', async () => {
  useIdentityContext.getState().setActiveOrganizationId(org);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).endsWith('/organizations')
    ? Response.json({ organizations: [{ organizationId: org, organizationName: 'Private organization', role: 'OWNER' }] })
    : Response.json({ actorRole: 'OWNER', branches: [{ id: org, name: 'Private branch', status: 'ACTIVE', version: 1 }] }));
  render(<Workspace page="branches" />);
  await screen.findAllByText('Private branch');
  fireEvent(window, new StorageEvent('storage', { key: 'uco:identity-retired', newValue: 'retired' }));
  expect(screen.getByRole('heading', { name: 'Acceso local cerrado' })).toBeTruthy();
  expect(screen.queryByText('Private branch')).toBeNull();
  expect(document.body.textContent).not.toContain('Private organization');
});
it('does not reload private views while server logout remains pending', () => {
  localStorage.setItem('uco:logout-pending', 'true');
  const fetch = vi.spyOn(globalThis, 'fetch');
  render(<Workspace page="branches" />);
  expect(screen.getByText(/Falta confirmar el cierre/)).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
