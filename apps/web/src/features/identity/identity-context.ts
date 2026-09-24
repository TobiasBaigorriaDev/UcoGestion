'use client';

import { create } from 'zustand';

type IdentityContext = {
  activeOrganizationId: string | null;
  activeBranchId: string | null;
  setActiveOrganizationId: (id: string | null) => void;
  setActiveBranchId: (id: string | null) => void;
};

export const useIdentityContext = create<IdentityContext>((set, get) => ({
  activeOrganizationId: null,
  activeBranchId: null,
  setActiveOrganizationId: (id) => {
    if (typeof window !== 'undefined') {
      if (id) window.sessionStorage.setItem('uco-active-organization', id);
      else window.sessionStorage.removeItem('uco-active-organization');
    }
    set({ activeOrganizationId: id, activeBranchId: get().activeOrganizationId === id ? get().activeBranchId : null });
  },
  setActiveBranchId: (id) => {
    const organizationId = get().activeOrganizationId;
    if (!organizationId) return;
    if (typeof window !== 'undefined') {
      const key = `uco-active-branch:${organizationId}`;
      if (id) window.sessionStorage.setItem(key, id);
      else window.sessionStorage.removeItem(key);
    }
    set({ activeBranchId: id });
  },
}));
