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
import { loadUserManagement, UserManagement } from './user-management';
import { BranchManagement, loadBranches } from './branch-management';
import { CatalogReadView, loadCatalog } from '../catalog/catalog-read';
import { CatalogCategoryManagement, loadManagedCategories } from '../catalog/catalog-category-management';
import { ExpenseCategoryManagement, loadExpenseCategories } from '../expenses/expense-category-management';
import { CatalogItemManagement, loadManagedItems } from '../catalog/catalog-item-management';

type WorkspacePage = 'home' | 'settings' | 'users' | 'branches' | 'catalog' | 'catalog-categories' | 'catalog-items' | 'expense-categories';

export function Workspace({ page = 'home' }: { page?: WorkspacePage }) {
  return <RemoteProvider><WorkspaceContent page={page} /></RemoteProvider>;
}

function WorkspaceContent({ page }: { page: WorkspacePage }) {
  const activeId = useIdentityContext((state) => state.activeOrganizationId);
  const setActiveId = useIdentityContext((state) => state.setActiveOrganizationId);
  const activeBranchId = useIdentityContext((state) => state.activeBranchId);
  const setActiveBranchId = useIdentityContext((state) => state.setActiveBranchId);
  const [switchError, setSwitchError] = useState<ApiProblemError | null>(null);
  const memberships = useQuery({ queryKey: ['memberships'], queryFn: loadMemberships });
  const settings = useQuery({
    queryKey: ['organization-settings', activeId],
    queryFn: () => loadOrganizationSettings(activeId ?? ''),
    enabled: page === 'settings' && !!activeId,
  });
  const users = useQuery({ queryKey: ['user-management', activeId], queryFn: () => loadUserManagement(activeId ?? ''), enabled: page === 'users' && !!activeId });
  const branches = useQuery({ queryKey: ['branches', activeId], queryFn: () => loadBranches(activeId ?? ''), enabled: !!activeId });
  const catalog = useQuery({ queryKey: ['catalog', activeId], queryFn: () => loadCatalog(activeId ?? ''), enabled: page === 'catalog' && !!activeId });
  const managedCategories = useQuery({ queryKey: ['managed-categories', activeId], queryFn: () => loadManagedCategories(activeId ?? ''), enabled: page === 'catalog-categories' && !!activeId });
  const expenseCategories = useQuery({ queryKey: ['expense-categories', activeId], queryFn: () => loadExpenseCategories(activeId ?? ''), enabled: page === 'expense-categories' && !!activeId });
  const managedItems = useQuery({ queryKey: ['managed-items', activeId], queryFn: () => loadManagedItems(activeId ?? ''), enabled: page === 'catalog-items' && !!activeId });

  useEffect(() => {
    const available = memberships.data;
    if (!available) return;
    const remembered = window.sessionStorage.getItem('uco-active-organization');
    if (!activeId && available.some((item) => item.organizationId === remembered)) setActiveId(remembered);
    if (activeId && !available.some((item) => item.organizationId === activeId)) setActiveId(null);
  }, [activeId, memberships.data, setActiveId]);

  useEffect(() => {
    if (!activeId || !branches.data) return;
    const available = branches.data.branches.filter((branch) => branch.status === 'ACTIVE');
    if (available.some((branch) => branch.id === activeBranchId)) return;
    const remembered = window.sessionStorage.getItem(`uco-active-branch:${activeId}`);
    const selected = available.find((branch) => branch.id === remembered)?.id ?? available[0]?.id ?? null;
    setActiveBranchId(selected);
  }, [activeId, activeBranchId, branches.data, setActiveBranchId]);

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
  return <AppShell organizations={organizations.map((item) => ({ id: item.organizationId, name: item.organizationName, branches: item.organizationId === activeId ? branches.data?.branches.filter((branch) => branch.status === 'ACTIVE').map((branch) => ({ id: branch.id, name: branch.name })) ?? [] : [] }))}
    activeOrganizationId={activeId} activeBranchId={activeBranchId} onOrganizationChange={(id) => void changeOrganization(id)} onBranchChange={setActiveBranchId}
    navigation={[{ href: '/workspace', label: 'Inicio' }, { href: '/workspace/catalog', label: 'Catálogo' }, { href: '/workspace/branches', label: 'Sucursales' }, ...(current?.role === 'OWNER' || current?.role === 'ADMIN' ? [{ href: '/workspace/users', label: 'Usuarios' }, { href: '/workspace/expense-categories', label: 'Categorías de gasto' }] : []), { href: '/workspace/settings', label: 'Configuración' }]}
    currentPath={page === 'home' ? '/workspace' : page === 'catalog-categories' || page === 'catalog-items' ? '/workspace/catalog' : `/workspace/${page}`}>
      {switchError ? <ErrorSummary error={switchError} /> : null}
      {branches.error ? <><ErrorSummary error={branches.error instanceof ApiProblemError ? branches.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar las sucursales.' })} /><button type="button" onClick={() => void branches.refetch()}>Reintentar sucursales</button></> : null}
      {page === 'catalog-items' ? current?.role !== 'OWNER' && current?.role !== 'ADMIN'
        ? <p role="alert">No tenés permiso para administrar ítems.</p>
        : managedItems.error
          ? <><ErrorSummary error={managedItems.error instanceof ApiProblemError ? managedItems.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar los ítems.' })} /><button type="button" onClick={() => void managedItems.refetch()}>Reintentar</button></>
          : managedItems.data ? <CatalogItemManagement organizationId={activeId} items={managedItems.data} onReload={() => void managedItems.refetch()} /> : <p role="status">Cargando ítems…</p>
      : page === 'expense-categories' ? current?.role !== 'OWNER' && current?.role !== 'ADMIN'
        ? <p role="alert">No tenés permiso para administrar categorías de gasto.</p>
        : expenseCategories.error
          ? <><ErrorSummary error={expenseCategories.error instanceof ApiProblemError ? expenseCategories.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar las categorías de gasto.' })} /><button type="button" onClick={() => void expenseCategories.refetch()}>Reintentar</button></>
          : expenseCategories.data ? <ExpenseCategoryManagement organizationId={activeId} categories={expenseCategories.data} onReload={() => void expenseCategories.refetch()} /> : <p role="status">Cargando categorías de gasto…</p>
      : page === 'catalog-categories' ? current?.role !== 'OWNER' && current?.role !== 'ADMIN'
        ? <p role="alert">No tenés permiso para administrar categorías.</p>
        : managedCategories.error
          ? <><ErrorSummary error={managedCategories.error instanceof ApiProblemError ? managedCategories.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar las categorías.' })} /><button type="button" onClick={() => void managedCategories.refetch()}>Reintentar</button></>
          : managedCategories.data ? <CatalogCategoryManagement organizationId={activeId} categories={managedCategories.data} onReload={() => void managedCategories.refetch()} /> : <p role="status">Cargando categorías…</p>
      : page === 'catalog' ? catalog.error
        ? <><ErrorSummary error={catalog.error instanceof ApiProblemError ? catalog.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar el catálogo.' })} /><button type="button" onClick={() => void catalog.refetch()}>Reintentar</button></>
        : catalog.data && current ? <CatalogReadView key={`${activeId}:${activeBranchId ?? ''}`} role={current.role} data={catalog.data} branchId={activeBranchId} loadHistory={(branchId) => loadCatalog(activeId, branchId)} /> : <p role="status">Cargando catálogo…</p>
      : page === 'branches' ? branches.error ? null : branches.data
        ? <BranchManagement organizationId={activeId} data={branches.data} onReload={() => void branches.refetch()} /> : <p role="status">Cargando sucursales…</p>
      : page === 'users' ? users.error
        ? <><ErrorSummary error={users.error instanceof ApiProblemError ? users.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar los usuarios.' })} /><button type="button" onClick={() => void users.refetch()}>Reintentar</button></>
        : users.data ? <UserManagement organizationId={activeId} data={users.data} onReload={() => { void users.refetch(); void branches.refetch(); }} /> : <p role="status">Cargando usuarios…</p>
      : page === 'settings' ? settings.error
        ? <><ErrorSummary error={settings.error instanceof ApiProblemError ? settings.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar la configuración.' })} /><button type="button" onClick={() => void settings.refetch()}>Reintentar</button></>
        : settings.data && current
          ? <OrganizationSettings key={activeId} organizationId={activeId} role={current.role} initial={settings.data} />
          : <p role="status">Cargando configuración…</p>
        : <section><h1>{current?.organizationName}</h1><p>Organización activa. Elegí Configuración para revisar el perfil comercial.</p></section>}
    </AppShell>;
}
