'use client';

import { create } from 'zustand';

type IdentityContext = {
  activeOrganizationId: string | null;
  setActiveOrganizationId: (id: string | null) => void;
};

export const useIdentityContext = create<IdentityContext>((set) => ({
  activeOrganizationId: null,
  setActiveOrganizationId: (id) => {
    if (typeof window !== 'undefined') {
      if (id) window.sessionStorage.setItem('uco-active-organization', id);
      else window.sessionStorage.removeItem('uco-active-organization');
    }
    set({ activeOrganizationId: id });
  },
}));
