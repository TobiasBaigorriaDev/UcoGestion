'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import { loadCatalog } from '../catalog/catalog-read';
import { loadSuppliers } from '../suppliers/supplier-management';
import { loadCheckoutContext } from '../sales/sales-api';
import { PurchaseCreation } from './purchase-creation';
import { PurchaseHistory } from './purchase-history';
import { PurchaseLookup } from './purchase-lookup';
import styles from '../sales/pos.module.css';
import workspaceStyles from './purchase-workspace.module.css';

const client = new ApiClient();
const supplierSchema = z.object({ id: z.string(), name: z.string(), status: z.string() });

async function receptionSuppliers(organizationId: string, branchId: string) {
  const response = await client.request(`/suppliers/reception/${encodeURIComponent(branchId)}`,
    { method: 'GET', organizationId,
      parse: (raw) => z.object({ items: z.array(supplierSchema) }).parse(raw) });
  return response?.items ?? [];
}

export function PurchaseWorkspace({ organizationId, branchId, role, timezone, branches }: {
  organizationId: string; branchId: string; role: 'OWNER' | 'ADMIN' | 'EMPLOYEE';
  timezone: string; branches: readonly { id: string; name: string }[];
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const refreshHistory = () => {
    void queryClient.invalidateQueries({ queryKey: ['purchase-history', organizationId] });
    void queryClient.invalidateQueries({ queryKey: ['purchase-trends', organizationId] });
  };
  const catalog = useQuery({ queryKey: ['purchase-catalog', organizationId],
    queryFn: () => loadCatalog(organizationId) });
  const suppliers = useQuery({ queryKey: ['purchase-suppliers', organizationId, branchId, role],
    queryFn: () => role === 'EMPLOYEE' ? receptionSuppliers(organizationId, branchId)
      : loadSuppliers(organizationId) });
  const checkout = useQuery({ queryKey: ['purchase-checkout', organizationId, branchId],
    queryFn: () => loadCheckoutContext(organizationId, branchId), enabled: role !== 'EMPLOYEE' });
  const failure = catalog.error ?? suppliers.error ?? checkout.error;
  return <div className={styles.page}><header><h1>Compras</h1>
    <p>{role === 'EMPLOYEE' ? 'Registrá mercadería recibida o consultá tus recepciones.'
      : 'Revisá el historial o registrá una nueva compra.'}</p></header>
    {role !== 'EMPLOYEE' ? <PurchaseHistory organizationId={organizationId} branchId={branchId}
      branches={branches} timezone={timezone} onSelect={setSelectedId} /> : null}
    {failure ? <><ErrorSummary error={failure instanceof ApiProblemError ? failure
      : new ApiProblemError({ status: 0, code: 'PURCHASE_CONTEXT_FAILED',
        message: 'No pudimos cargar los datos de compra. Intentá nuevamente.' })} />
      <button type="button" onClick={() => { void catalog.refetch(); void suppliers.refetch(); void checkout.refetch(); }}>Reintentar</button></>
      : !catalog.data || !suppliers.data || role !== 'EMPLOYEE' && !checkout.data
        ? <p role="status">Cargando datos de compra…</p> : <div className={workspaceStyles.operations}><PurchaseCreation organizationId={organizationId} branchId={branchId} role={role}
    suppliers={suppliers.data.filter((supplier) => supplier.status === 'ACTIVE')}
    items={catalog.data.items.filter((item) => item.type === 'PRODUCT' && item.status === 'ACTIVE')}
    paymentMethods={checkout.data?.paymentMethods ?? []} sessions={checkout.data?.sessions ?? []}
    onConfirmed={refreshHistory} />
    <PurchaseLookup organizationId={organizationId} branchId={branchId} role={role}
      selectedId={selectedId} onChanged={refreshHistory}
      paymentMethods={checkout.data?.paymentMethods ?? []} sessions={checkout.data?.sessions ?? []} /></div>}
  </div>;
}
