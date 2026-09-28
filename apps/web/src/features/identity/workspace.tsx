'use client';

import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

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
import { CustomerManagement, loadCustomers } from '../customers/customer-management';
import { SupplierManagement, loadSuppliers } from '../suppliers/supplier-management';
import { CashRegisterManagement, loadCashRegisters } from '../cash/cash-register-management';
import { PaymentMethodsManagement, loadPaymentMethods } from '../organizations/payment-methods-management';
import { InventoryStock } from '../inventory/inventory-stock';
import { loadStocks } from '../inventory/inventory-api';
import { loadAdjustments, loadTransfers } from '../inventory/inventory-api';
import { InventoryAdjustments } from '../inventory/inventory-adjustments';
import { InventoryTransfers } from '../inventory/inventory-transfers';
import { PosOnline } from '../sales/pos-online';
import { SaleLookup } from '../sales/sale-lookup';
import { PurchaseWorkspace } from '../purchases/purchase-workspace';
import { ExpensePage } from '../expenses/expense-page';
import { DashboardWorkspace } from '../insights/dashboard-workspace';
import { AuditWorkspace } from '../insights/audit-workspace';
import { ReportsWorkspace } from '../insights/reports-workspace';

type WorkspacePage =
  | 'home'
  | 'settings'
  | 'users'
  | 'branches'
  | 'catalog'
  | 'catalog-categories'
  | 'catalog-items'
  | 'expense-categories'
  | 'customers'
  | 'suppliers'
  | 'cash-registers'
  | 'payment-methods'
  | 'inventory'
  | 'inventory-adjustments'
  | 'inventory-transfers'
  | 'pos'
  | 'sales'
  | 'purchases'
  | 'expenses'
  | 'audit'
  | 'reports';

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
    enabled: (page === 'settings' || page === 'home' || page === 'audit' || page === 'reports') && !!activeId,
  });
  const users = useQuery({ queryKey: ['user-management', activeId], queryFn: () => loadUserManagement(activeId ?? ''), enabled: page === 'users' && !!activeId });
  const branches = useQuery({ queryKey: ['branches', activeId], queryFn: () => loadBranches(activeId ?? ''), enabled: !!activeId });
  const catalog = useQuery({ queryKey: ['catalog', activeId], queryFn: () => loadCatalog(activeId ?? ''), enabled: (page === 'catalog' || page === 'pos') && !!activeId });
  const managedCategories = useQuery({ queryKey: ['managed-categories', activeId], queryFn: () => loadManagedCategories(activeId ?? ''), enabled: page === 'catalog-categories' && !!activeId });
  const expenseCategories = useQuery({ queryKey: ['expense-categories', activeId], queryFn: () => loadExpenseCategories(activeId ?? ''), enabled: page === 'expense-categories' && !!activeId });
  const managedItems = useQuery({ queryKey: ['managed-items', activeId], queryFn: () => loadManagedItems(activeId ?? ''), enabled: page === 'catalog-items' && !!activeId });
  const customers = useQuery({ queryKey: ['customers', activeId], queryFn: () => loadCustomers(activeId ?? ''), enabled: page === 'customers' && !!activeId });
  const suppliers = useQuery({ queryKey: ['suppliers', activeId], queryFn: () => loadSuppliers(activeId ?? ''), enabled: page === 'suppliers' && !!activeId });
  const cashRegisters = useQuery({
    queryKey: ['cash-registers', activeId, activeBranchId],
    queryFn: () => loadCashRegisters(activeId ?? '', activeBranchId ?? ''),
    enabled: page === 'cash-registers' && !!activeId && !!activeBranchId,
  });
  const paymentMethods = useQuery({ queryKey: ['payment-methods', activeId], queryFn: () => loadPaymentMethods(activeId ?? ''), enabled: page === 'payment-methods' && !!activeId });
  const stocks = useInfiniteQuery({
    queryKey: ['inventory-stocks', activeId, activeBranchId],
    queryFn: ({ pageParam }) => loadStocks(activeId ?? '', activeBranchId ?? '', pageParam || undefined),
    initialPageParam: '', getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: (page === 'inventory' || page === 'inventory-adjustments' || page === 'inventory-transfers') && !!activeId && !!activeBranchId,
  });
  const adjustments = useInfiniteQuery({
    queryKey: ['inventory-adjustments', activeId, activeBranchId],
    queryFn: ({ pageParam }) => loadAdjustments(activeId ?? '', activeBranchId ?? '', pageParam || undefined),
    initialPageParam: '', getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: page === 'inventory-adjustments' && !!activeId && !!activeBranchId,
  });
  const transfers = useInfiniteQuery({
    queryKey: ['inventory-transfers', activeId, activeBranchId],
    queryFn: ({ pageParam }) => loadTransfers(activeId ?? '', activeBranchId ?? '', pageParam || undefined),
    initialPageParam: '', getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: page === 'inventory-transfers' && !!activeId && !!activeBranchId,
  });

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
    navigation={[
      { href: '/workspace', label: 'Inicio' },
      { href: '/workspace/catalog', label: 'Catálogo' },
      ...(current?.role === 'EMPLOYEE' ? [] : [
        { href: '/workspace/pos', label: 'POS' },
        { href: '/workspace/sales', label: 'Ventas' },
      ]),
      ...(current?.role === 'CASHIER' ? [] : [{ href: '/workspace/purchases', label: 'Compras' }]),
      ...(current?.role === 'EMPLOYEE' ? [] : [{ href: '/workspace/expenses', label: 'Gastos' }]),
      { href: '/workspace/inventory', label: 'Inventario' },
      { href: '/workspace/reports', label: 'Reportes' },
      ...(current?.role === 'CASHIER' ? [] : [{ href: '/workspace/inventory/adjustments', label: 'Ajustes' }]),
      ...(current?.role === 'CASHIER' ? [] : [{ href: '/workspace/inventory/transfers', label: 'Transferencias' }]),
      { href: '/workspace/branches', label: 'Sucursales' },
      { href: '/workspace/customers', label: 'Clientes' },
      { href: '/workspace/suppliers', label: 'Proveedores' },
      { href: '/workspace/cash-registers', label: 'Cajas' },
      ...(current?.role === 'OWNER' || current?.role === 'ADMIN'
        ? [
            { href: '/workspace/users', label: 'Usuarios' },
            { href: '/workspace/expense-categories', label: 'Categorías de gasto' },
            { href: '/workspace/payment-methods', label: 'Medios de pago' },
            { href: '/workspace/audit', label: 'Auditoría' },
          ]
        : []),
      { href: '/workspace/settings', label: 'Configuración' },
    ]}
    currentPath={page === 'home' ? '/workspace' : page === 'catalog-categories' || page === 'catalog-items' ? '/workspace/catalog' : page === 'inventory-adjustments' ? '/workspace/inventory/adjustments' : page === 'inventory-transfers' ? '/workspace/inventory/transfers' : `/workspace/${page}`}>
      {switchError ? <ErrorSummary error={switchError} /> : null}
      {branches.error ? <><ErrorSummary error={branches.error instanceof ApiProblemError ? branches.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar las sucursales.' })} /><button type="button" onClick={() => void branches.refetch()}>Reintentar sucursales</button></> : null}
      {page === 'reports' && current ? settings.error
        ? <><ErrorSummary error={settings.error instanceof ApiProblemError ? settings.error : new ApiProblemError({ status: 0, code: 'SETTINGS_LOAD_FAILED', message: 'No pudimos cargar la zona horaria de la organización.' })} /><button type="button" onClick={() => void settings.refetch()}>Reintentar</button></>
        : settings.data ? <ReportsWorkspace key={activeId} organizationId={activeId}
          role={current.role} timezone={settings.data.timezone} branches={branches.data?.branches.filter((branch) => branch.status === 'ACTIVE').map((branch) => ({ id: branch.id, name: branch.name })) ?? []} />
        : <p role="status">Cargando zona horaria…</p>
      : page === 'audit' ? current?.role !== 'OWNER' && current?.role !== 'ADMIN'
        ? <p role="alert">No tenés acceso a la auditoría.</p>
        : settings.error
          ? <><ErrorSummary error={settings.error instanceof ApiProblemError ? settings.error : new ApiProblemError({ status: 0, code: 'SETTINGS_LOAD_FAILED', message: 'No pudimos cargar la zona horaria de la organización.' })} /><button type="button" onClick={() => void settings.refetch()}>Reintentar</button></>
          : settings.data ? <AuditWorkspace key={activeId} organizationId={activeId} timezone={settings.data.timezone}
          branches={branches.data?.branches.filter((branch) => branch.status === 'ACTIVE').map((branch) => ({ id: branch.id, name: branch.name })) ?? []} />
          : <p role="status">Cargando zona horaria…</p>
      : page === 'expenses' ? current?.role === 'EMPLOYEE'
        ? <p role="alert">No tenés permiso para registrar gastos.</p>
        : !activeBranchId || !current ? <p>Seleccioná una sucursal para registrar gastos.</p>
        : <ExpensePage key={`${activeId}:${activeBranchId}`} organizationId={activeId}
          branchId={activeBranchId} role={current.role} />
      : page === 'purchases' ? current?.role === 'CASHIER'
        ? <p role="alert">No tenés permiso para operar compras.</p>
        : !activeBranchId || !current ? <p>Seleccioná una sucursal para registrar compras.</p>
        : <PurchaseWorkspace key={`${activeId}:${activeBranchId}`} organizationId={activeId}
          branchId={activeBranchId} role={current.role} />
      : page === 'sales' ? current?.role === 'EMPLOYEE'
        ? <p role="alert">No tenés permiso para consultar ventas.</p>
        : !activeBranchId || !current
        ? <p>Seleccioná una sucursal para consultar ventas.</p>
        : <SaleLookup key={`${activeId}:${activeBranchId}`} organizationId={activeId}
          branchId={activeBranchId} role={current.role} />
      : page === 'pos' ? current?.role === 'EMPLOYEE'
        ? <p role="alert">No tenés permiso para confirmar ventas.</p>
        : !activeBranchId
        ? <p>Seleccioná una sucursal para vender.</p>
        : catalog.error
          ? <><ErrorSummary error={catalog.error instanceof ApiProblemError ? catalog.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar el catálogo.' })} /><button type="button" onClick={() => void catalog.refetch()}>Reintentar</button></>
          : catalog.data && current ? <PosOnline key={`${activeId}:${activeBranchId}`} organizationId={activeId}
            branchId={activeBranchId} role={current.role} items={catalog.data.items} />
            : <p role="status">Cargando productos…</p>
      : page === 'catalog-items' ? current?.role !== 'OWNER' && current?.role !== 'ADMIN'
        ? <p role="alert">No tenés permiso para administrar ítems.</p>
        : managedItems.error
          ? <><ErrorSummary error={managedItems.error instanceof ApiProblemError ? managedItems.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar los ítems.' })} /><button type="button" onClick={() => void managedItems.refetch()}>Reintentar</button></>
          : managedItems.data ? <CatalogItemManagement organizationId={activeId} items={managedItems.data} onReload={() => void managedItems.refetch()} /> : <p role="status">Cargando ítems…</p>
      : page === 'inventory-transfers' ? !activeBranchId || !current || !branches.data
        ? <p>Seleccioná una sucursal para transferir stock.</p>
        : stocks.error || transfers.error ? <><ErrorSummary error={(stocks.error ?? transfers.error) instanceof ApiProblemError ? (stocks.error ?? transfers.error) as ApiProblemError : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar las transferencias.' })} /><button type="button" onClick={() => { void stocks.refetch(); void transfers.refetch(); }}>Reintentar</button></>
          : stocks.data && transfers.data ? <InventoryTransfers key={`${activeId}:${activeBranchId}`} organizationId={activeId}
              role={current.role} branches={branches.data.branches.filter((branch) => branch.status === 'ACTIVE')}
              originBranchId={activeBranchId} stocks={stocks.data.pages.flatMap((page) => page.stocks)}
              transfers={transfers.data.pages.flatMap((page) => page.transfers)}
              nextCursor={transfers.data.pages.at(-1)?.nextCursor ?? null} onOriginChange={setActiveBranchId}
              onReload={() => { void stocks.refetch(); void transfers.refetch(); }}
              {...(stocks.hasNextPage ? { onLoadMoreStocks: () => void stocks.fetchNextPage() } : {})}
              onLoadMore={() => void transfers.fetchNextPage()} /> : <p role="status">Cargando transferencias…</p>
      : page === 'inventory-adjustments' ? !activeBranchId || !current
        ? <p>Seleccioná una sucursal para registrar ajustes.</p>
        : stocks.error || adjustments.error ? <><ErrorSummary error={(stocks.error ?? adjustments.error) instanceof ApiProblemError ? (stocks.error ?? adjustments.error) as ApiProblemError : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar los ajustes.' })} /><button type="button" onClick={() => { void stocks.refetch(); void adjustments.refetch(); }}>Reintentar</button></>
          : stocks.data && adjustments.data ? <InventoryAdjustments key={`${activeId}:${activeBranchId}`} organizationId={activeId}
              branchId={activeBranchId} role={current.role} stocks={stocks.data.pages.flatMap((page) => page.stocks)}
              adjustments={adjustments.data.pages.flatMap((page) => page.adjustments)}
              nextCursor={adjustments.data.pages.at(-1)?.nextCursor ?? null}
              onReload={() => { void adjustments.refetch(); void stocks.refetch(); }}
              {...(stocks.hasNextPage ? { onLoadMoreStocks: () => void stocks.fetchNextPage() } : {})}
              onLoadMore={() => void adjustments.fetchNextPage()} /> : <p role="status">Cargando ajustes…</p>
      : page === 'inventory' ? !activeBranchId || !branches.data || !current
        ? <p>Seleccioná una sucursal para consultar el stock.</p>
        : stocks.error ? <><ErrorSummary error={stocks.error instanceof ApiProblemError ? stocks.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar el stock.' })} /><button type="button" onClick={() => void stocks.refetch()}>Reintentar</button></>
          : stocks.data ? <InventoryStock key={`${activeId}:${activeBranchId}`} organizationId={activeId}
              role={current.role} branches={branches.data.branches.filter((branch) => branch.status === 'ACTIVE')}
              branchId={activeBranchId} stocks={stocks.data.pages.flatMap((page) => page.stocks)}
              nextCursor={stocks.data.pages.at(-1)?.nextCursor ?? null} onBranchChange={setActiveBranchId}
              onReload={() => void stocks.refetch()} onLoadMore={() => void stocks.fetchNextPage()} />
            : <p role="status">Cargando stock…</p>
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
      : page === 'customers' ? customers.error
        ? <><ErrorSummary error={customers.error instanceof ApiProblemError ? customers.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar los clientes.' })} /><button type="button" onClick={() => void customers.refetch()}>Reintentar</button></>
        : customers.data && current ? <CustomerManagement organizationId={activeId} role={current.role} customers={customers.data} onReload={() => void customers.refetch()} /> : <p role="status">Cargando clientes…</p>
      : page === 'suppliers' ? suppliers.error
        ? <><ErrorSummary error={suppliers.error instanceof ApiProblemError ? suppliers.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar los proveedores.' })} /><button type="button" onClick={() => void suppliers.refetch()}>Reintentar</button></>
        : suppliers.data && current ? <SupplierManagement organizationId={activeId} role={current.role} suppliers={suppliers.data} onReload={() => void suppliers.refetch()} /> : <p role="status">Cargando proveedores…</p>
      : page === 'cash-registers' ? !activeBranchId ? <p>Seleccioná una sucursal para ver sus cajas.</p>
        : cashRegisters.error
          ? <><ErrorSummary error={cashRegisters.error instanceof ApiProblemError ? cashRegisters.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar las cajas.' })} /><button type="button" onClick={() => void cashRegisters.refetch()}>Reintentar</button></>
          : cashRegisters.data && current && branches.data ? (
            <CashRegisterManagement
              key={`${activeId}:${activeBranchId}`}
              organizationId={activeId}
              role={current.role}
              branches={branches.data.branches.filter((b) => b.status === 'ACTIVE').map((b) => ({ id: b.id, name: b.name }))}
              selectedBranchId={activeBranchId}
              cashRegisters={cashRegisters.data}
              onReload={() => void cashRegisters.refetch()}
              onBranchChange={setActiveBranchId}
            />
          ) : <p role="status">Cargando cajas…</p>
      : page === 'payment-methods' ? current?.role !== 'OWNER' && current?.role !== 'ADMIN'
        ? <p role="alert">No tenés permiso para administrar medios de pago.</p>
        : paymentMethods.error
          ? <><ErrorSummary error={paymentMethods.error instanceof ApiProblemError ? paymentMethods.error : new ApiProblemError({ status: 0, code: 'LOAD_FAILED', message: 'No pudimos cargar los medios de pago.' })} /><button type="button" onClick={() => void paymentMethods.refetch()}>Reintentar</button></>
          : paymentMethods.data && current ? <PaymentMethodsManagement organizationId={activeId} role={current.role} methods={paymentMethods.data} onReload={() => void paymentMethods.refetch()} /> : <p role="status">Cargando medios de pago…</p>
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
        : page === 'home' && current ? settings.error
          ? <><ErrorSummary error={settings.error instanceof ApiProblemError ? settings.error : new ApiProblemError({ status: 0, code: 'SETTINGS_LOAD_FAILED', message: 'No pudimos cargar la zona horaria de la organización.' })} /><button type="button" onClick={() => void settings.refetch()}>Reintentar</button></>
          : settings.data ? <DashboardWorkspace key={activeId} organizationId={activeId}
          role={current.role} timezone={settings.data.timezone} branches={branches.data?.branches.filter((branch) => branch.status === 'ACTIVE').map((branch) => ({ id: branch.id, name: branch.name })) ?? []} />
          : <p role="status">Cargando zona horaria…</p>
        : <section><h1>{current?.organizationName}</h1><p>Organización activa.</p></section>}
    </AppShell>;
}
