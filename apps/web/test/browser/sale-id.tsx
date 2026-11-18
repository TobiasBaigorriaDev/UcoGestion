import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import '../../../../packages/ui/src/tokens.css';
import { PosOnline } from '../../src/features/sales/pos-online';
import { SaleLookup } from '../../src/features/sales/sale-lookup';
import { OfflineWorkspace } from '../../src/features/offline/offline-workspace';
import { loadCatalog, type CatalogReadData } from '../../src/features/catalog/catalog-read';
import { CustomerManagement, loadCustomers } from '../../src/features/customers/customer-management';

const params = new URL(location.href).searchParams;
const organizationId = params.get('organizationId') ?? '', branchId = params.get('branchId') ?? '';
function Fixture() {
  const [mode, setMode] = useState('online');
  const [items, setItems] = useState<CatalogReadData['items']>([]);
  useEffect(() => { void loadCatalog(organizationId).then(data => setItems(data.items)); }, []);
  return <QueryClientProvider client={client}><main>
    <nav aria-label="Ventas"><button onClick={() => setMode('online')}>Venta online</button>
      <button onClick={() => setMode('offline')}>Venta offline</button><button onClick={() => setMode('lookup')}>Consultar venta por ID</button>
      <button onClick={() => setMode('customers')}>Clientes</button></nav>
    {mode === 'online' ? <PosOnline organizationId={organizationId} branchId={branchId} role="OWNER" items={items} />
      : mode === 'offline' ? <OfflineWorkspace organizationId={organizationId} branchId={branchId} role="OWNER" />
      : mode === 'lookup' ? <SaleLookup organizationId={organizationId} branchId={branchId} role="OWNER" /> : <CustomersFixture />}
  </main></QueryClientProvider>;
}
function CustomersFixture() {
  const customers = useQuery({ queryKey: ['customers', organizationId], queryFn: () => loadCustomers(organizationId) });
  return customers.data ? <CustomerManagement organizationId={organizationId} branchId={branchId}
    role="OWNER" customers={customers.data} onReload={() => void customers.refetch()} /> : <p>Cargando clientes…</p>;
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const element = document.getElementById('root');
if (!element) throw new Error('Missing root');
createRoot(element).render(<Fixture />);
