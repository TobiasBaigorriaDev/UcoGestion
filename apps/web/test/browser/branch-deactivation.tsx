import React from 'react';
import { createRoot } from 'react-dom/client';
import axe from 'axe-core';
import { BranchManagement } from '../../src/features/identity/branch-management';
Object.assign(window, { axe });
document.body.style.padding = '24px';
document.documentElement.style.setProperty('--font-plus-jakarta', '"Plus Jakarta Sans", "Plus Jakarta Sans Fallback"');
const root = document.getElementById('root'); if (!root) throw new Error('Missing root');
createRoot(root).render(<BranchManagement organizationId="11111111-1111-4111-8111-111111111111" data={{ actorRole: 'OWNER', branches: [{ id: '44444444-4444-4444-8444-444444444444', name: 'Principal', status: 'ACTIVE', version: 1 }] }} onReload={() => {}} />);
