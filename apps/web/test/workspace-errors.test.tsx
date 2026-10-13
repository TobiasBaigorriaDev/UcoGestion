import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Workspace } from '../src/features/identity/workspace';
import { useIdentityContext } from '../src/features/identity/identity-context';
const org = '11111111-1111-4111-8111-111111111111';
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear();
  useIdentityContext.getState().setActiveBranchId(null);
  useIdentityContext.getState().setActiveOrganizationId(null); });
it('T225 preserves the report page heading when timezone loading fails', async () => {
  useIdentityContext.getState().setActiveOrganizationId(org);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input).endsWith('/organizations')) return Response.json({ organizations: [{ organizationId: org, organizationName: 'Uco', role: 'OWNER' }] });
    if (String(input).endsWith('/branches')) return Response.json({ actorRole: 'OWNER', branches: [] });
    return Response.json({ status: 403, code: 'FORBIDDEN', detail: 'No disponible', traceId: 'test' }, { status: 403, headers: { 'Content-Type': 'application/problem+json' } });
  });
  render(<Workspace page="reports" />);
  await screen.findByRole('button', { name: 'Reintentar' }, { timeout: 15000 });
  expect(screen.getByRole('heading', { name: 'Reportes', level: 1 })).toBeTruthy();
}, 20000);

it('D07 waits for the organization timezone before showing purchase date filters', async () => {
  const branch = '22222222-2222-4222-8222-222222222222';
  useIdentityContext.getState().setActiveOrganizationId(org);
  useIdentityContext.getState().setActiveBranchId(branch);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input).endsWith('/organizations')) return Response.json({ organizations: [
      { organizationId: org, organizationName: 'Uco', role: 'OWNER' }] });
    if (String(input).endsWith('/branches')) return Response.json({ actorRole: 'OWNER', branches: [
      { id: branch, name: 'Principal', status: 'ACTIVE' }] });
    return Response.json({ status: 503, code: 'SETTINGS_UNAVAILABLE', detail: 'Zona horaria no disponible',
      traceId: 'test' }, { status: 503, headers: { 'Content-Type': 'application/problem+json' } });
  });
  render(<Workspace page="purchases" />);
  await screen.findByRole('button', { name: 'Reintentar' }, { timeout: 15000 });
  expect(screen.queryByRole('heading', { name: 'Historial de compras' })).toBeNull();
}, 20000);
