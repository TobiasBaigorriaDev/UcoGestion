'use client';

import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import { loadCatalog } from '../catalog/catalog-read';
import { loadSuppliers } from '../suppliers/supplier-management';
import { loadCheckoutContext } from '../sales/sales-api';
import { PurchaseCreation } from './purchase-creation';
import { PurchaseLookup } from './purchase-lookup';

const client = new ApiClient();
const supplierSchema = z.object({ id: z.string(), name: z.string(), status: z.string() });

async function receptionSuppliers(organizationId: string, branchId: string) {
  const response = await client.request(`/suppliers/reception/${encodeURIComponent(branchId)}`,
    { method: 'GET', organizationId,
      parse: (raw) => z.object({ items: z.array(supplierSchema) }).parse(raw) });
  return response?.items ?? [];
}

export function PurchaseWorkspace({ organizationId, branchId, role }: {
  organizationId: string; branchId: string; role: 'OWNER' | 'ADMIN' | 'EMPLOYEE';
}) {
  const catalog = useQuery({ queryKey: ['purchase-catalog', organizationId],
    queryFn: () => loadCatalog(organizationId) });
  const suppliers = useQuery({ queryKey: ['purchase-suppliers', organizationId, branchId, role],
    queryFn: () => role === 'EMPLOYEE' ? receptionSuppliers(organizationId, branchId)
      : loadSuppliers(organizationId) });
  const checkout = useQuery({ queryKey: ['purchase-checkout', organizationId, branchId],
    queryFn: () => loadCheckoutContext(organizationId, branchId), enabled: role !== 'EMPLOYEE' });
  const failure = catalog.error ?? suppliers.error ?? checkout.error;
  if (failure) return <><ErrorSummary error={failure instanceof ApiProblemError ? failure
    : new ApiProblemError({ status: 0, code: 'PURCHASE_CONTEXT_FAILED',
      message: 'No pudimos cargar los datos de compra. Intentá nuevamente.' })} />
    <button type="button" onClick={() => { void catalog.refetch(); void suppliers.refetch(); void checkout.refetch(); }}>Reintentar</button></>;
  if (!catalog.data || !suppliers.data || role !== 'EMPLOYEE' && !checkout.data) {
    return <p role="status">Cargando datos de compra…</p>;
  }
  return <><PurchaseCreation organizationId={organizationId} branchId={branchId} role={role}
    suppliers={suppliers.data.filter((supplier) => supplier.status === 'ACTIVE')}
    items={catalog.data.items.filter((item) => item.type === 'PRODUCT' && item.status === 'ACTIVE')}
    paymentMethods={checkout.data?.paymentMethods ?? []} sessions={checkout.data?.sessions ?? []} />
    <PurchaseLookup organizationId={organizationId} branchId={branchId} role={role}
      paymentMethods={checkout.data?.paymentMethods ?? []} sessions={checkout.data?.sessions ?? []} /></>;
}
