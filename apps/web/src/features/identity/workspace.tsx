'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { AppShell } from '../../components/app-shell';
import { ApiProblemError } from '../../lib/api/client';
import { ErrorSummary } from '../../components/error-summary';
import { loadMemberships, selectOrganization } from './auth-flow';
import { useIdentityContext } from './identity-context';
import { loadOrganizationSettings, OrganizationSettings } from './organization-settings';
import { RemoteProvider } from './remote-provider';

export function Workspace({ settingsPage = false }: { settingsPage?: boolean }) {
  return <RemoteProvider><WorkspaceContent settingsPage={settingsPage} /></RemoteProvider>;
}

function WorkspaceContent({ settingsPage }: { settingsPage: boolean }) {
  const activeId = useIdentityContext((state) => state.activeOrganizationId);
  const setActiveId = useIdentityContext((state) => state.setActiveOrganizationId);
  const [switchError, setSwitchError] = useState<ApiProblemError | null>(null);
  const memberships = useQuery({ queryKey: ['memberships'], queryFn: loadMemberships });
  const settings = useQuery({
    queryKey: ['organization-settings', activeId],
    queryFn: () => loadOrganizationSettings(activeId ?? ''),
    enabled: settingsPage && !!activeId,
  });

  useEffect(() => {
    const available = memberships.data;
    if (!available) return;
    const remembered = window.sessionStorage.getItem('uco-active-organization');
    if (!activeId && available.some((item) => item.organizationId === remembered)) setActiveId(remembered);
    if (activeId && !available.some((item) => item.organizationId === activeId)) setActiveId(null);
  }, [activeId, memberships.data, setActiveId]);

  async function changeOrganization(id: string) {
    setSwitchError(null);
    try { await selectOrganization(id); setActiveId(id); }
    catch (cause) {
      setSwitchError(cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0, code: 'SWITCH_FAILED', message: 'No pudimos cambiar la organización. Intentá nuevamente.' }));
    }
  }

  if (memberships.isPending) return <main><p role="status">Cargando contexto de trabajo…</p></main>;
  if (memberships.error) return <main><ErrorSummary error={memberships.error instanceof ApiProblemError ? memberships.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar tus organizaciones.' })} /><button type="button" onClick={() => void memberships.refetch()}>Reintentar</button></main>;
  if (!activeId) return <main><p>Elegí una organización para continuar.</p><a href="/organizations/select">Seleccionar organización</a></main>;
  const organizations = memberships.data;
  const current = organizations.find((item) => item.organizationId === activeId);
  return <AppShell organizations={organizations.map((item) => ({ id: item.organizationId, name: item.organizationName, branches: [] }))}
    activeOrganizationId={activeId} activeBranchId={null} onOrganizationChange={(id) => void changeOrganization(id)} onBranchChange={() => {}}
    navigation={[{ href: '/workspace', label: 'Inicio' }, { href: '/workspace/settings', label: 'Configuración' }]}
    currentPath={settingsPage ? '/workspace/settings' : '/workspace'}>
      {switchError ? <ErrorSummary error={switchError} /> : null}
      {settingsPage ? settings.error
        ? <><ErrorSummary error={settings.error instanceof ApiProblemError ? settings.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar la configuración.' })} /><button type="button" onClick={() => void settings.refetch()}>Reintentar</button></>
        : settings.data && current
          ? <OrganizationSettings key={activeId} organizationId={activeId} role={current.role} initial={settings.data} />
          : <p role="status">Cargando configuración…</p>
        : <section><h1>{current?.organizationName}</h1><p>Organización activa. Elegí Configuración para revisar el perfil comercial.</p></section>}
    </AppShell>;
}
