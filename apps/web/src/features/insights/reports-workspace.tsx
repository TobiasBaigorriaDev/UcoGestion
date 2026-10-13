'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { downloadReportCsv, loadReport, loadReportExport, queueReportExport,
  type ReportDataset, type ReportFilters, type ReportPage } from './insights-api';
import type { ReportExport } from './insights-api';
import styles from './insights.module.css';
import reportStyles from './reports-workspace.module.css';
import { dashboardPeriodRange, dashboardRangeLabel, formatDashboardAmount, type DashboardPreset } from './dashboard-presentation';
import { buildReportTrends, loadReportChartRows, reportChartRange, reportRangeFilters } from './report-trends';
import { TrendChart } from './trend-chart';

type Role = 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
const labels: Record<ReportDataset, string> = { sales: 'Ventas', inventory: 'Inventario actual',
  'inventory-movements': 'Movimientos de inventario', cash: 'Caja', purchases: 'Compras', expenses: 'Gastos' };
const fields: Record<ReportDataset, readonly string[]> = {
  sales: ['branchId', 'occurredAt', 'status', 'total', 'currencyCode'],
  inventory: ['branchId', 'name', 'quantity', 'minimum', 'lowStock'],
  'inventory-movements': ['branchId', 'occurredAt', 'itemName', 'delta', 'effectKind'],
  cash: ['branchId', 'openedAt', 'status', 'expectedCash', 'difference'],
  purchases: ['branchId', 'occurredAt', 'status', 'total', 'currencyCode'],
  expenses: ['branchId', 'occurredAt', 'status', 'amount', 'currencyCode'],
};
const columnLabels: Record<string, string> = { branchId: 'Sucursal', occurredAt: 'Fecha', status: 'Estado',
  total: 'Total', currencyCode: 'Moneda', name: 'Ítem', quantity: 'Cantidad', minimum: 'Mínimo',
  lowStock: 'Stock bajo', itemId: 'ID de ítem', itemName: 'Ítem', delta: 'Cambio',
  effectKind: 'Efecto', openedAt: 'Apertura', expectedCash: 'Efectivo esperado',
  difference: 'Diferencia', amount: 'Importe' };
const statuses: Partial<Record<ReportDataset, readonly string[]>> = {
  sales: ['CONFIRMED', 'CANCELLED'], cash: ['OPEN', 'CLOSING', 'CONFLICTED', 'CLOSED',
    'CLOSED_CONFLICT_RESOLVED', 'CLOSED_WITH_UNRECOVERED_DEVICE'],
  purchases: ['PENDING_PAYMENT', 'PAID', 'CANCELLED'], expenses: ['CONFIRMED', 'CANCELLED'],
};
const statusLabels: Record<string, string> = { CONFIRMED: 'Confirmada', CANCELLED: 'Anulada',
  PENDING_PAYMENT: 'Pendiente de pago', PAID: 'Pagada', OPEN: 'Abierta', CLOSING: 'En cierre',
  CONFLICTED: 'En conflicto', CLOSED: 'Cerrada', CLOSED_CONFLICT_RESOLVED: 'Cerrada tras conciliación',
  CLOSED_WITH_UNRECOVERED_DEVICE: 'Cerrada con dispositivo irrecuperable' };
function allowedDatasets(role: Role): ReportDataset[] {
  if (role === 'CASHIER') return ['sales', 'cash'];
  if (role === 'EMPLOYEE') return ['inventory', 'inventory-movements'];
  return ['sales', 'inventory', 'inventory-movements', 'cash', 'purchases', 'expenses'];
}
function display(value: unknown): string {
  if (value === true) return 'Sí';
  if (value === false) return 'No';
  if (value == null) return '—';
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '—';
}
function displayField(field: string, value: unknown, timezone: string): string {
  if (typeof value === 'string' && (field === 'occurredAt' || field === 'openedAt')) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('es-AR', { timeZone: timezone });
  }
  if (field === 'status' && typeof value === 'string') return statusLabels[value] ?? value;
  return display(value);
}

export function ReportsWorkspace({ organizationId, role, branches, timezone, load = loadReport,
  queueExport = queueReportExport, loadExport = loadReportExport, downloadCsv = downloadReportCsv, now }: {
  organizationId: string; role: Role; branches: readonly { id: string; name: string }[]; timezone: string;
  load?: (organizationId: string, dataset: ReportDataset, filters: ReportFilters) => Promise<ReportPage>;
  queueExport?: (organizationId: string, dataset: ReportDataset, filters: Omit<ReportFilters, 'cursor'>, key: string) => Promise<ReportExport>;
  loadExport?: (organizationId: string, id: string) => Promise<ReportExport>;
  downloadCsv?: (organizationId: string, dataset: ReportDataset, filters: Omit<ReportFilters, 'cursor'>) => Promise<void>;
  now?: Date;
}) {
  const datasets = allowedDatasets(role);
  const [dataset, setDataset] = useState<ReportDataset>(datasets[0]!);
  const [clock, setClock] = useState(() => now ?? new Date());
  useEffect(() => {
    if (now) return;
    const update = () => setClock(new Date());
    const interval = window.setInterval(update, 60_000);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', update); };
  }, [now]);
  const initialRange = dashboardPeriodRange('day', timezone, clock);
  const [period, setPeriod] = useState<DashboardPreset | 'custom' | 'all'>('day');
  const [draft, setDraft] = useState({ branchId: '', from: initialRange.from, to: initialRange.through, status: '', lowStock: '' });
  const [filters, setFilters] = useState<ReportFilters>(() => datasets[0] === 'inventory' ? {} : reportRangeFilters(initialRange));
  const [exportId, setExportId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'csv' | 'pdf' | null>(null);
  const exportKey = useRef<string | null>(null);
  const invalidPeriod = dataset !== 'inventory' && period !== 'all' && (!draft.from || !draft.to || draft.from > draft.to);
  const query = useInfiniteQuery({ queryKey: ['report', organizationId, dataset, filters], initialPageParam: '',
    queryFn: ({ pageParam }) => load(organizationId, dataset, { ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined });
  const exportStatus = useQuery({ queryKey: ['report-export', organizationId, exportId],
    queryFn: () => loadExport(organizationId, exportId!), enabled: !!exportId,
    refetchInterval: (query) => query.state.data?.status === 'QUEUED' || query.state.data?.status === 'PROCESSING' ? 3000 : false });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const range = reportChartRange(filters);
  const chart = useQuery({ queryKey: ['report-chart', organizationId, dataset, filters],
    enabled: dataset !== 'inventory' && !!range,
    queryFn: async ({ signal }) => {
      const rows = await loadReportChartRows(load, organizationId, dataset, filters, signal);
      if (range) buildReportTrends(rows, dataset, range, timezone, clock);
      return rows;
    }, retry: false });
  const trends = chart.data && !chart.error && range ? buildReportTrends(chart.data, dataset, range, timezone, clock) : null;
  const appliedLabel = dataset === 'inventory' ? 'Estado actual' : range ? dashboardRangeLabel(range) : filters.from && filters.to
    ? dashboardRangeLabel({ from: filters.from, through: new Date(Date.parse(filters.to) - 86_400_000).toISOString().slice(0, 10) }) : 'Todo el historial';
  function applyDraft(next: typeof draft, choice = period) {
    setFilters({ ...(next.branchId ? { branchId: next.branchId } : {}), ...(next.status ? { status: next.status } : {}),
      ...(dataset === 'inventory' ? (next.lowStock ? { lowStock: next.lowStock } : {})
        : choice === 'all' ? {} : reportRangeFilters({ from: next.from, through: next.to })) });
    setExportId(null); exportKey.current = null; setExportError(null);
  }
  function choosePeriod(choice: typeof period) {
    setPeriod(choice);
    if (choice === 'custom') return;
    const nextRange = choice === 'all' ? initialRange : dashboardPeriodRange(choice, timezone, clock);
    const next = { ...draft, from: nextRange.from, to: nextRange.through };
    setDraft(next); applyDraft(next, choice);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (invalidPeriod) return;
    applyDraft(draft);
  }
  function switchDataset(value: ReportDataset) {
    setDataset(value);
    const next = { ...draft, from: invalidPeriod ? initialRange.from : draft.from,
      to: invalidPeriod ? initialRange.through : draft.to, status: '', lowStock: '' };
    setDraft(next);
    setFilters({ ...(draft.branchId ? { branchId: draft.branchId } : {}),
      ...(value === 'inventory' || period === 'all' ? {} : reportRangeFilters({ from: next.from, through: next.to })) });
    setExportId(null); exportKey.current = null; setExportError(null);
  }
  async function csv() {
    setBusy('csv'); setExportError(null);
    try { await downloadCsv(organizationId, dataset, filters); }
    catch (error) { setExportError(error instanceof Error ? error.message : 'No pudimos descargar el CSV.'); }
    finally { setBusy(null); }
  }
  async function pdf() {
    setBusy('pdf'); setExportError(null);
    try {
      if (exportStatus.data?.status === 'EXPIRED' || exportStatus.data?.status === 'FAILED') exportKey.current = null;
      exportKey.current ??= crypto.randomUUID();
      const result = await queueExport(organizationId, dataset, filters, exportKey.current);
      setExportId(result.id);
    } catch (error) { setExportError(error instanceof ApiProblemError ? error.message : 'No pudimos iniciar la exportación PDF. Intentá nuevamente.'); }
    finally { setBusy(null); }
  }
  return <div className={styles.workspace}>
    <header className={styles.heading}><h1>Reportes</h1><p>Explorá la evolución de tu negocio y descargá los datos que necesitás.</p></header>
    <form className={reportStyles.filters} onSubmit={submit}>
      <div className={reportStyles.controls}>
      <div className={styles.field}><label htmlFor="report-dataset">Tipo de reporte</label><select id="report-dataset" value={dataset} onChange={(event) => switchDataset(event.target.value as ReportDataset)}>{datasets.map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select></div>
      <div className={styles.field}><label htmlFor="report-branch">Sucursal</label><select id="report-branch" value={draft.branchId} onChange={(event) => setDraft({ ...draft, branchId: event.target.value })}><option value="">Todas las autorizadas</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div>
      {statuses[dataset] && <div className={styles.field}><label htmlFor="report-status">Estado</label><select id="report-status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}><option value="">Todos</option>{statuses[dataset]?.map((value) => <option key={value} value={value}>{statusLabels[value] ?? value}</option>)}</select></div>}
      {dataset === 'inventory' && <div className={styles.field}><label htmlFor="report-low-stock">Stock bajo</label><select id="report-low-stock" value={draft.lowStock} onChange={(event) => setDraft({ ...draft, lowStock: event.target.value })}><option value="">Todos</option><option value="true">Solo stock bajo</option><option value="false">Sin stock bajo</option></select></div>}
      </div>
      {dataset !== 'inventory' && <div className={reportStyles.period} role="group" aria-label="Período del reporte">
        {([{ key: 'day', label: 'Hoy' }, { key: 'week', label: 'Esta semana' }, { key: 'month', label: 'Este mes' },
          { key: 'custom', label: 'Personalizado' }, { key: 'all', label: 'Todo el historial' }] as const).map(item =>
          <button key={item.key} type="button" aria-pressed={period === item.key} onClick={() => choosePeriod(item.key)}>{item.label}</button>)}
      </div>}
      <div className={reportStyles.controls}>
      {dataset !== 'inventory' && period === 'custom' && <><div className={styles.field}><label htmlFor="report-from">Desde</label><input id="report-from" type="date" required value={draft.from} aria-invalid={invalidPeriod} aria-describedby={invalidPeriod ? 'report-period-error' : undefined} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></div>
      <div className={styles.field}><label htmlFor="report-to">Hasta</label><input id="report-to" type="date" required value={draft.to} aria-invalid={invalidPeriod} aria-describedby={invalidPeriod ? 'report-period-error' : undefined} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></div></>}
      <button className={styles.button} type="submit" disabled={invalidPeriod}>Aplicar filtros</button>
      <p className={reportStyles.note}>{dataset === 'inventory' ? 'El inventario refleja el stock actual; no un período histórico.' : `Las fechas incluyen el día completo. Zona horaria: ${timezone}.`}</p>
      </div>
    </form>
    {invalidPeriod && <p id="report-period-error" role="alert">Elegí ambas fechas. Hasta debe ser igual o posterior a Desde.</p>}
    {dataset !== 'inventory' && <section className={styles.section} aria-labelledby="report-trends-heading">
      <div className={reportStyles.resultHeader}><h2 id="report-trends-heading">Evolución de {labels[dataset].toLocaleLowerCase('es')}</h2><p>{appliedLabel}</p></div>
      <p className={reportStyles.note}>Cantidad de registros{['sales', 'purchases', 'expenses'].includes(dataset) ? ' e importe neto, sin operaciones anuladas' : ''} {range?.from === range?.through ? 'por hora' : 'por día'}. Los períodos en curso llegan hasta el presente.</p>
      {!range && <p>Los gráficos admiten hasta 31 días. Elegí un período más corto para ver la evolución; el reporte y las exportaciones siguen disponibles.</p>}
      {range && chart.isPending && <p role="status">Cargando gráficos…</p>}
      {range && chart.error && <><p role="alert">{chart.error instanceof Error ? chart.error.message : 'No pudimos cargar los gráficos.'}</p><button className={reportStyles.secondary} type="button" onClick={() => void chart.refetch()}>Reintentar gráficos</button></>}
      {trends && (trends.labels.length ? <>
        {!chart.data?.length && <p>Sin operaciones para este período.</p>}
        <div className={reportStyles.charts}>
          {trends.amounts.map(series => <TrendChart key={series.currency} headingLevel={3}
            title={dataset === 'expenses' ? `Gastos por categoría · ${series.currency}` : `Importe neto · ${series.currency}`} currency={series.currency}
            labels={trends.labels} values={series.values} display={series.values.map(value => `${formatDashboardAmount(value)} ${series.currency}`)}
            {...(dataset === 'expenses' ? { series: trends.categories.filter(category => category.currency === series.currency).map(category => ({
              id: category.id, name: category.name, values: category.values,
              display: category.values.map(value => `${formatDashboardAmount(value)} ${series.currency}`),
            })) } : {})} />)}
          <TrendChart headingLevel={3} title={dataset === 'cash' ? 'Sesiones de caja' : dataset === 'inventory-movements' ? 'Movimientos de inventario' : 'Operaciones no anuladas'}
            labels={trends.labels} values={trends.counts} display={trends.counts} />
        </div></> : <p>El período seleccionado todavía no empezó.</p>)}
    </section>}
    {query.isPending && <p role="status">Cargando reporte…</p>}
    {query.error && <><ErrorSummary error={query.error instanceof ApiProblemError ? query.error : new ApiProblemError({ status: 0, code: 'REPORT_LOAD_FAILED', message: 'No pudimos cargar el reporte. Intentá nuevamente.' })} /><button type="button" className={styles.button} onClick={() => void query.refetch()}>Reintentar</button></>}
    {query.data && !query.error && <section className={styles.section}>
      <div className={reportStyles.resultHeader}><h2>{labels[dataset]}</h2><p>{appliedLabel} · {items.length} registros cargados</p></div>
      {query.data.pages[0]?.net !== undefined && <p>Importe neto: <strong>{formatDashboardAmount(query.data.pages[0].net)}</strong>. Las operaciones anuladas permanecen visibles con su estado.</p>}
      {items.length ? <div className={styles.tableWrap}><table className={`${styles.table} ${reportStyles.table}`}><caption>Registros del reporte con los filtros aplicados</caption><thead><tr>{fields[dataset].map((field) => <th scope="col" key={field}>{columnLabels[field]}</th>)}</tr></thead><tbody>{items.map((item) => <tr key={`${item.branchId}:${item.id}`}>{fields[dataset].map((field) => <td key={field} data-label={columnLabels[field]}>{field === 'branchId' ? branches.find((branch) => branch.id === item.branchId)?.name ?? item.branchId
        : field === 'status' ? <span className={reportStyles.status} data-cancelled={item.status === 'CANCELLED'}>{displayField(field, item[field], timezone)}</span>
        : (field === 'total' || field === 'amount' || field === 'expectedCash' || field === 'difference') && typeof item[field] === 'string' ? formatDashboardAmount(item[field])
        : displayField(field, item[field], timezone)}</td>)}</tr>)}</tbody></table></div> : <p>Sin registros para los filtros elegidos.</p>}
      {query.hasNextPage && <button type="button" className={styles.button} disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Cargando…' : 'Cargar más registros'}</button>}
    </section>}
    <section className={styles.section}><div className={reportStyles.export}><div><h2>Exportar datos filtrados</h2><p>{appliedLabel}. Se exportan todos los registros autorizados del período.</p></div><div className={styles.actions}>
      <button className={reportStyles.secondary} type="button" disabled={busy !== null || invalidPeriod} onClick={() => void csv()}>{busy === 'csv' ? 'Descargando…' : 'Descargar CSV'}</button>
      <button className={reportStyles.secondary} type="button" disabled={busy !== null || invalidPeriod} onClick={() => void pdf()}>{busy === 'pdf' ? 'Solicitando…' : 'Generar PDF'}</button>
    </div></div>
      {exportError && <p role="alert">{exportError}</p>}
      {exportId && <div aria-live="polite"><p>Exportación PDF: {exportStatus.data?.status ?? 'Consultando estado…'}</p>
        {exportStatus.error && <><p role="alert">No pudimos consultar la exportación.</p><button type="button" className={styles.button} onClick={() => void exportStatus.refetch()}>Reintentar consulta</button></>}
        {exportStatus.data?.errorCode && <p role="alert">La exportación falló ({exportStatus.data.errorCode}). Revisá los filtros e intentá nuevamente.</p>}
        {exportStatus.data?.status === 'EXPIRED' && <p>El archivo venció. Generá otra exportación.</p>}
        {exportStatus.data?.url && <a className={styles.link} href={exportStatus.data.url} target="_blank" rel="noopener noreferrer">Descargar PDF listo</a>}
      </div>}
    </section>
  </div>;
}
