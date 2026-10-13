'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { saleCodeFromId } from '@uconext/shared';
import { OrganizationTime } from '../../components/organization-time';
import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { dashboardPeriodRange, formatDashboardAmount,
  type DashboardPreset } from '../insights/dashboard-presentation';
import { TrendChart } from '../insights/trend-chart';
import { loadSaleHistory, loadSaleTrends, type SaleHistoryFilters } from './sales-api';
import styles from './pos.module.css';

function localDateAndHour(timezone: string, instant: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const part = (type: string) => parts.find(entry => entry.type === type)?.value ?? '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) };
}

export function SaleHistory({ organizationId, branchId, branches, timezone, onSelect }: {
  organizationId: string; branchId: string; branches: readonly { id: string; name: string }[];
  timezone: string; onSelect: (id: string) => void;
}) {
  const today = () => dashboardPeriodRange('day', timezone, new Date());
  const [draft, setDraft] = useState(() => ({ from: today().from, to: today().through, status: '' }));
  const [filters, setFilters] = useState<SaleHistoryFilters>(() => ({ from: today().from, to: today().through }));
  const [period, setPeriod] = useState<DashboardPreset | 'custom'>('day');
  const [selectedBranch, setSelectedBranch] = useState(branchId);
  const branchOptions = branches.some(branch => branch.id === branchId)
    ? branches : [{ id: branchId, name: 'Sucursal activa' }, ...branches];
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const updateClock = () => setClock(new Date());
    const interval = window.setInterval(updateClock, 60_000);
    document.addEventListener('visibilitychange', updateClock);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', updateClock); };
  }, []);
  const cursor = cursors.at(-1);
  const selectedBranchId = selectedBranch || undefined;
  const trendsInRange = !!filters.from && !!filters.to &&
    (Date.parse(filters.to) - Date.parse(filters.from)) / 86_400_000 <= 30;
  const groupBy = filters.from === filters.to ? 'HOUR' : 'DAY';
  const history = useQuery({ queryKey: ['sale-history', organizationId, selectedBranchId, filters, cursor],
    queryFn: () => loadSaleHistory(organizationId, selectedBranchId, { ...filters, cursor }), retry: false });
  const trends = useQuery({ queryKey: ['sale-trends', organizationId, selectedBranchId, filters.from, filters.to, groupBy],
    queryFn: () => loadSaleTrends(organizationId, { from: filters.from ?? today().from,
      to: filters.to ?? today().through, branchId: selectedBranchId, groupBy }), enabled: trendsInRange,
    retry: false });
  function choosePeriod(next: DashboardPreset) {
    const range = dashboardPeriodRange(next, timezone, new Date());
    setPeriod(next); setDraft(previous => ({ ...previous, from: range.from, to: range.through }));
    setFilters(previous => ({ ...previous, from: range.from, to: range.through }));
    setError(null); setCursors([undefined]);
  }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) {
      setError(new ApiProblemError({ status: 400, code: 'SALE_HISTORY_DATES_INVALID',
        message: 'La fecha Desde debe ser anterior o igual a Hasta.' })); return;
    }
    setPeriod('custom'); setError(null); setCursors([undefined]);
    setFilters({ ...(draft.from ? { from: draft.from } : {}), ...(draft.to ? { to: draft.to } : {}),
      ...(draft.status === 'CONFIRMED' || draft.status === 'CANCELLED' ? { status: draft.status } : {}) });
  }
  const queryError = history.error instanceof ApiProblemError ? history.error
    : new ApiProblemError({ status: 0, code: 'SALE_HISTORY_FAILED',
      message: 'No pudimos cargar el historial. Intentá nuevamente.' });
  const currentLocal = localDateAndHour(timezone, clock);
  const visiblePoints = trends.data?.points.filter(point => point.date < currentLocal.date ||
    point.date === currentLocal.date && (point.hour === undefined || point.hour <= currentLocal.hour)) ?? [];
  const trendLabels = visiblePoints.map(point => point.hour === undefined ? point.date
    : `${point.date}T${String(point.hour).padStart(2, '0')}:00`);
  return <section className={styles.panel} aria-labelledby="sale-history-heading">
    <h2 id="sale-history-heading">Historial de ventas</h2>
    <p>Ventas de las sucursales autorizadas, de la más reciente a la más antigua.</p>
    <div className={styles.periodButtons} role="group" aria-label="Período de ventas">
      {([{ key: 'day', label: 'Hoy' }, { key: 'week', label: 'Esta semana' },
        { key: 'month', label: 'Este mes' }] as const).map(item => <button key={item.key}
        type="button" aria-pressed={period === item.key} onClick={() => choosePeriod(item.key)}>{item.label}</button>)}
    </div>
    <div className={styles.branchFilter}><label htmlFor="sales-branch">Sucursal</label>
      <select id="sales-branch" value={selectedBranch} onChange={event => {
        setSelectedBranch(event.target.value); setCursors([undefined]); }}>
        <option value="">Todas las autorizadas</option>
        {branchOptions.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
      </select></div>
    <form onSubmit={apply} className={styles.historyFilters}>
      <div><label htmlFor="sales-from">Desde</label><input id="sales-from" type="date" value={draft.from}
        onChange={event => setDraft({ ...draft, from: event.target.value })} /></div>
      <div><label htmlFor="sales-to">Hasta</label><input id="sales-to" type="date" value={draft.to}
        onChange={event => setDraft({ ...draft, to: event.target.value })} /></div>
      <div><label htmlFor="sales-status">Estado de venta</label><select id="sales-status" value={draft.status}
        onChange={event => setDraft({ ...draft, status: event.target.value })}>
        <option value="">Todas</option><option value="CONFIRMED">Confirmadas</option>
        <option value="CANCELLED">Anuladas</option></select></div>
      <button type="submit">Aplicar filtros</button>
    </form>
    <p>Las fechas incluyen todo el día según la zona horaria del negocio ({timezone}).</p>
    {error ? <ErrorSummary error={error} /> : null}
    <section className={styles.trends} aria-labelledby="sale-trends-heading">
      <h3 id="sale-trends-heading">Ventas a través del tiempo</h3>
      <p>Importe neto y cantidad de ventas confirmadas {groupBy === 'HOUR' ? 'por hora' : 'por día'}.
        Las anuladas no suman. Los períodos en curso llegan hasta el presente.</p>
      {!trendsInRange ? <p>Los gráficos admiten hasta 31 días. Acotá las fechas para verlos; el historial sigue disponible.</p> : null}
      {trendsInRange && trends.isPending ? <p role="status">Cargando gráficos…</p> : null}
      {trends.error ? <><p role="alert">No pudimos cargar los gráficos.</p>
        <button type="button" onClick={() => void trends.refetch()}>Reintentar gráficos</button></> : null}
      {trends.data && visiblePoints.length ? <div className={styles.chartGrid}>
        <TrendChart title="Dinero vendido" values={visiblePoints.map(point => point.amount)}
          labels={trendLabels}
          display={visiblePoints.map(point => `${formatDashboardAmount(point.amount)} ${trends.data.currency}`)}
          currency={trends.data.currency} />
        <TrendChart title="Cantidad de ventas" values={visiblePoints.map(point => String(point.count))}
          labels={trendLabels}
          display={visiblePoints.map(point => String(point.count))} />
      </div> : trends.data ? <p>El período seleccionado todavía no empezó.</p> : null}
    </section>
    {history.isPending ? <p role="status">Cargando historial…</p> : null}
    {history.error ? <><ErrorSummary error={queryError} />
      <button type="button" onClick={() => void history.refetch()}>Reintentar</button></> : null}
    {history.data ? <>
      {!history.data.items.length ? <p role="status">No hay ventas para estos filtros.</p> :
        <ul className={styles.historyList} aria-label="Ventas de las sucursales autorizadas">
          {history.data.items.map(sale => <li key={sale.id}>
            <span><strong>{sale.status === 'CANCELLED' ? 'Anulada' : 'Confirmada'}</strong>
              <OrganizationTime value={sale.confirmedAt} />
              <small>{branchOptions.find(branch => branch.id === sale.branchId)?.name ??
                (sale.branchId || 'Sucursal no informada')}</small></span>
            <strong className={styles.historyTotal}>{sale.total} {sale.currency}</strong>
            <button type="button" aria-label={`Ver venta ${saleCodeFromId(sale.id)}`} onClick={() => onSelect(sale.id)}>
              <span>ID de venta</span><span className={styles.historyId}>{saleCodeFromId(sale.id)}</span>
            </button>
          </li>)}
        </ul>}
    </> : null}
    <nav className={styles.historyPagination} aria-label="Paginación de ventas">
      <button type="button" disabled={cursors.length === 1 || history.isFetching}
        onClick={() => setCursors(cursors.slice(0, -1))}>Anterior</button>
      <span role="status">Página {cursors.length}</span>
      <button type="button" disabled={!history.data?.nextCursor || history.isFetching || history.isError}
        onClick={() => { if (history.data?.nextCursor) setCursors([...cursors, history.data.nextCursor]); }}>Siguiente</button>
    </nav>
  </section>;
}
