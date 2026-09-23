'use client';

import { useQuery } from '@tanstack/react-query';
import { ApiProblemError } from '../../lib/api/client';
import { ErrorSummary } from '../../components/error-summary';
import { loadMemberships, OrganizationSelector } from './auth-flow';
import { RemoteProvider } from './remote-provider';

export function OrganizationSelectorLoader() {
  return <RemoteProvider><OrganizationSelection /></RemoteProvider>;
}

function OrganizationSelection() {
  const { data, error, isPending, refetch } = useQuery({ queryKey: ['memberships'], queryFn: loadMemberships });
  if (isPending) return <p role="status">Cargando organizaciones…</p>;
  if (error) return <><ErrorSummary error={error instanceof ApiProblemError ? error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar tus organizaciones. Intentá nuevamente.' })} /><button type="button" onClick={() => void refetch()}>Reintentar</button></>;
  return <OrganizationSelector organizations={data} />;
}
