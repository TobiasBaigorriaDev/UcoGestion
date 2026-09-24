import { afterEach, expect, it } from 'vitest';

import { useIdentityContext } from '../src/features/identity/identity-context.js';

afterEach(() => { window.sessionStorage.clear(); useIdentityContext.getState().setActiveOrganizationId(null); });

it('keeps the selected branch scoped to its organization', () => {
  useIdentityContext.getState().setActiveOrganizationId('org-a');
  useIdentityContext.getState().setActiveBranchId('branch-a');
  expect(useIdentityContext.getState().activeBranchId).toBe('branch-a');
  useIdentityContext.getState().setActiveOrganizationId('org-b');
  expect(useIdentityContext.getState().activeBranchId).toBeNull();
  useIdentityContext.getState().setActiveBranchId('branch-b');
  expect(window.sessionStorage.getItem('uco-active-branch:org-a')).toBe('branch-a');
  expect(window.sessionStorage.getItem('uco-active-branch:org-b')).toBe('branch-b');
});
