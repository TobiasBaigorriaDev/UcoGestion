'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ErrorSummary } from '../../components/error-summary';
import { OrganizationTime } from '../../components/organization-time';
import { ApiProblemError } from '../../lib/api/client';
import { dashboardPeriodRange, formatDashboardAmount,
  type DashboardPreset } from '../insights/dashboard-presentation';
import { TrendChart } from '../insights/trend-chart';
import { loadPurchaseHistory, loadPurchaseTrends,
  type PurchaseHistoryFilters } from './purchases-api';
import styles from '../sales/pos.module.css';
import workspaceStyles from './purchase-workspace.module.css';

function localDateAndHour(timezone: string, instant: Date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const part = (type: string) => parts.find(entry => entry.type === type)?.value ?? '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) };
}

export function PurchaseHistory({ organizationId, branchId, branches, timezone, onSelect }: {
  organizationId: string; branchId: string; branches: readonly { id: string; name: string }[];
  timezone: string; onSelect: (id: string | null) => void;
}) {
  const today = () => dashboardPeriodRange('day', timezone, new Date());
  const [draft, setDraft] = useState(() => ({ from: today().from, to: today().through, status: '' }));
  const [filters, setFilters] = useState<PurchaseHistoryFilters>(() => ({ from: today().from, to: today().through }));
  const [period, setPeriod] = useState<DashboardPreset | 'custom'>('day');
  const [selectedBranch, setSelectedBranch] = useState(branchId);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const refresh = () => setClock(new Date());
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  const selectedBranchId = selectedBranch || undefined;
  const branchOptions = branches.some(branch => branch.id === branchId) ? branches
    : [{ id: branchId, name: 'Sucursal activa' }, ...branches];
  const cursor = cursors.at(-1);
  const trendsInRange = !!filters.from && !!filters.to &&
    (Date.parse(filters.to) - Date.parse(filters.from)) / 86_400_000 <= 30;
  const groupBy = filters.from === filters.to ? 'HOUR' : 'DAY';
  const history = useQuery({ queryKey: ['purchase-history', organizationId, selectedBranchId, filters, cursor],
    queryFn: () => loadPurchaseHistory(organizationId, selectedBranchId, { ...filters, cursor }), retry: false });
  const trends = useQuery({ queryKey: ['purchase-trends', organizationId, selectedBranchId,
    filters.from, filters.to, groupBy], queryFn: () => loadPurchaseTrends(organizationId, {
    from: filters.from ?? today().from, to: filters.to ?? today().through,
    branchId: selectedBranchId, groupBy,
  }), enabled: trendsInRange, retry: false });
  function choosePeriod(next: DashboardPreset) {
    const range = dashboardPeriodRange(next, timezone, new Date());
    setPeriod(next); setDraft(previous => ({ ...previous, from: range.from, to: range.through }));
    setFilters(previous => ({ ...previous, from: range.from, to: range.through }));
    setError(null); setCursors([undefined]); onSelect(null);
  }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) {
      setError(new ApiProblemError({ status: 400, code: 'PURCHASE_HISTORY_DATES_INVALID',
        message: 'La fecha Desde debe ser anterior o igual a Hasta.' })); return;
    }
    setPeriod('custom'); setError(null); setCursors([undefined]); onSelect(null);
    setFilters({ ...(draft.from ? { from: draft.from } : {}), ...(draft.to ? { to: draft.to } : {}),
      ...(draft.status === 'PAID' || draft.status === 'PENDING_PAYMENT' || draft.status === 'CANCELLED'
        ? { status: draft.status } : {}) });
  }
  const current = localDateAndHour(timezone, clock);
  const visiblePoints = trends.data?.points.filter(point => point.date < current.date ||
    point.date === current.date && (point.hour === undefined || point.hour <= current.hour)) ?? [];
  const labels = visiblePoints.map(point => point.hour === undefined ? point.date
    : `${point.date}T${String(point.hour).padStart(2, '0')}:00`);
  const historyError = history.error instanceof ApiProblemError ? history.error
    : new ApiProblemError({ status: 0, code: 'PURCHASE_HISTORY_FAILED',
      message: 'No pudimos cargar el historial. Intentá nuevamente.' });
  return <section className={styles.panel} aria-labelledby="purchase-history-heading">
    <h2 id="purchase-history-heading">Historial de compras</h2>
    <p>Compras de las sucursales autorizadas, de la más reciente a la más antigua.</p>
    <div className={styles.periodButtons} role="group" aria-label="Período de compras">
      {([{ key: 'day', label: 'Hoy' }, { key: 'week', label: 'Esta semana' },
        { key: 'month', label: 'Este mes' }] as const).map(item => <button key={item.key}
        type="button" aria-pressed={period === item.key} onClick={() => choosePeriod(item.key)}>{item.label}</button>)}
    </div>
    <div className={styles.branchFilter}><label htmlFor="purchases-branch">Sucursal</label>
      <select id="purchases-branch" value={selectedBranch} onChange={event => {
        setSelectedBranch(event.target.value); setCursors([undefined]); onSelect(null);
      }}><option value="">Todas las autorizadas</option>
        {branchOptions.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
      </select></div>
    <form onSubmit={apply} className={styles.historyFilters}>
      <div><label htmlFor="purchases-from">Desde</label><input id="purchases-from" type="date"
        value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></div>
      <div><label htmlFor="purchases-to">Hasta</label><input id="purchases-to" type="date"
        value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></div>
      <div><label htmlFor="purchases-status">Estado de compra</label><select id="purchases-status"
        value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value })}>
        <option value="">Todas</option><option value="PENDING_PAYMENT">Pendientes de pago</option>
        <option value="PAID">Pagadas</option><option value="CANCELLED">Anuladas</option>
      </select></div><button type="submit">Aplicar filtros</button>
    </form>
    <p>Las fechas incluyen todo el día según la zona horaria del negocio ({timezone}).</p>
    {error ? <ErrorSummary error={error} /> : null}
    <section className={styles.trends} aria-labelledby="purchase-trends-heading">
      <h3 id="purchase-trends-heading">Compras a través del tiempo</h3>
      <p>Gasto neto y cantidad de compras {groupBy === 'HOUR' ? 'por hora' : 'por día'}.
        Las anuladas no suman. Los períodos en curso llegan hasta el presente.</p>
      {!trendsInRange ? <p>Los gráficos admiten hasta 31 días. Acotá las fechas para verlos; el historial sigue disponible.</p> : null}
      {trendsInRange && trends.isPending ? <p role="status">Cargando gráficos…</p> : null}
      {trends.error ? <><p role="alert">No pudimos cargar los gráficos.</p>
        <button type="button" onClick={() => void trends.refetch()}>Reintentar gráficos</button></> : null}
      {trends.data && visiblePoints.length ? <div className={styles.chartGrid}>
        <TrendChart title="Gasto neto" values={visiblePoints.map(point => point.amount)} labels={labels}
          display={visiblePoints.map(point => `${formatDashboardAmount(point.amount)} ${trends.data.currency}`)}
          currency={trends.data.currency} />
        <TrendChart title="Cantidad de compras" values={visiblePoints.map(point => String(point.count))}
          labels={labels} display={visiblePoints.map(point => String(point.count))} />
      </div> : trends.data ? <p>El período seleccionado todavía no empezó.</p> : null}
    </section>
    {history.isPending ? <p role="status">Cargando historial…</p> : null}
    {history.error ? <><ErrorSummary error={historyError} />
      <button type="button" onClick={() => void history.refetch()}>Reintentar historial</button></> : null}
    {history.data ? !history.data.items.length ? <p role="status">No hay compras para estos filtros.</p>
      : <ul className={`${styles.historyList} ${workspaceStyles.purchaseHistoryList}`}
          aria-label="Compras de las sucursales autorizadas">
        {history.data.items.map(purchase => <li key={purchase.id}>
          <span><strong>{purchase.supplierName}</strong>
            <span>{purchase.status === 'CANCELLED' ? 'Anulada' : purchase.status === 'PAID'
              ? 'Pagada' : 'Pendiente de pago'}</span>
            <OrganizationTime value={purchase.confirmedAt} />
            <small>{branchOptions.find(branch => branch.id === purchase.branchId)?.name ?? purchase.branchId}</small>
          </span>
          <span><strong className={styles.historyTotal}>{formatDashboardAmount(purchase.total)} {purchase.currency}</strong>
            <span>{purchase.items.map(item => `${item.itemName} × ${item.quantity}`).join(' · ')}</span></span>
          <button type="button" onClick={() => onSelect(purchase.id)}
            aria-label={`Ver compra ${purchase.id}`}>Ver detalle</button>
        </li>)}</ul> : null}
    <nav className={styles.historyPagination} aria-label="Paginación de compras">
      <button type="button" disabled={cursors.length === 1 || history.isFetching}
        onClick={() => setCursors(cursors.slice(0, -1))}>Anterior</button>
      <span role="status">Página {cursors.length}</span>
      <button type="button" disabled={!history.data?.nextCursor || history.isFetching || history.isError}
        onClick={() => { if (history.data?.nextCursor) setCursors([...cursors, history.data.nextCursor]); }}>Siguiente</button>
    </nav>
  </section>;
}
