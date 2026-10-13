import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../../../packages/ui/src/tokens.css';
import { OrganizationTimezone } from '../../src/components/organization-time';
import { PurchaseHistory } from '../../src/features/purchases/purchase-history';
import { PurchaseCreation } from '../../src/features/purchases/purchase-creation';
import { PurchaseLookup } from '../../src/features/purchases/purchase-lookup';
import workspaceStyles from '../../src/features/purchases/purchase-workspace.module.css';

const params = new URL(location.href).searchParams;
const organizationId = params.get('organizationId') ?? '';
const branchId = params.get('branchId') ?? '';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Fixture() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return <QueryClientProvider client={client}><OrganizationTimezone.Provider value="UTC">
    <main style={{ maxWidth: 1280, margin: '0 auto', padding: 16, display: 'grid', gap: 24 }}>
      <h1>Compras</h1>
      <PurchaseHistory organizationId={organizationId} branchId={branchId} timezone="UTC"
        branches={[{ id: branchId, name: 'Principal' }]} onSelect={setSelectedId} />
      <div className={workspaceStyles.operations}>
        <PurchaseCreation organizationId={organizationId} branchId={branchId} role="OWNER"
          suppliers={[{ id: '00000000-0000-4000-8000-000000000001', name: 'Bodega Sur' }]}
          items={[{ id: '00000000-0000-4000-8000-000000000002', name: 'Cajas', baseUnit: 'UNIT' }]}
          paymentMethods={[]} sessions={[]} />
        <PurchaseLookup organizationId={organizationId} branchId={branchId} role="OWNER"
          selectedId={selectedId} paymentMethods={[]} sessions={[]} />
      </div>
    </main>
  </OrganizationTimezone.Provider></QueryClientProvider>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(<Fixture />);
