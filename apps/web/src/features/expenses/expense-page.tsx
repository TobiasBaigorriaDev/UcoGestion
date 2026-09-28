'use client';

import { useQuery } from '@tanstack/react-query';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { loadCheckoutContext } from '../sales/sales-api';
import { loadActiveExpenseCategories } from './expenses-api';
import { ExpenseWorkspace } from './expense-workspace';

export function ExpensePage({ organizationId, branchId, role }: {
  organizationId: string; branchId: string; role: 'OWNER' | 'ADMIN' | 'CASHIER';
}) {
  const categories = useQuery({ queryKey: ['expense-active-categories', organizationId],
    queryFn: () => loadActiveExpenseCategories(organizationId) });
  const checkout = useQuery({ queryKey: ['expense-checkout', organizationId, branchId],
    queryFn: () => loadCheckoutContext(organizationId, branchId) });
  const failure = categories.error ?? checkout.error;
  if (failure) return <><ErrorSummary error={failure instanceof ApiProblemError ? failure
    : new ApiProblemError({ status: 0, code: 'EXPENSE_CONTEXT_FAILED',
      message: 'No pudimos cargar los datos de gastos. Intentá nuevamente.' })} />
    <button type="button" onClick={() => { void categories.refetch(); void checkout.refetch(); }}>Reintentar</button></>;
  if (!categories.data || !checkout.data) return <p role="status">Cargando datos de gastos…</p>;
  return <ExpenseWorkspace organizationId={organizationId} branchId={branchId} role={role}
    categories={categories.data} paymentMethods={checkout.data.paymentMethods}
    sessions={checkout.data.sessions} />;
}
