'use client';

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { loadDashboard, type DashboardData, type DashboardFilters } from './insights-api';
import { dashboardPeriodRange, dashboardRangeFilters, dashboardRangeLabel, formatDashboardAmount, moneyChartWidths, type DashboardPreset, type DashboardRange } from './dashboard-presentation';
import styles from './insights.module.css';
import dashboardStyles from './dashboard.module.css';

type Role = 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
type Branch = { id: string; name: string };
const methodNames: Record<string, string> = { CASH: 'Efectivo', CARD: 'Tarjeta', DEBIT_CARD: 'Tarjeta de débito', CREDIT_CARD: 'Tarjeta de crédito', TRANSFER: 'Transferencia', QR: 'QR' };
const presets: readonly { key: DashboardPreset | 'custom' | 'all'; label: string }[] = [
  { key: 'day', label: 'Hoy' }, { key: 'week', label: 'Esta semana' }, { key: 'month', label: 'Este mes' },
  { key: 'custom', label: 'Personalizado' }, { key: 'all', label: 'Todo el historial' },
];
function Money({ value }: { value: string }) { return <span>{formatDashboardAmount(value)}</span>; }
function ListSection({ title, note, items }: { title: string; note?: string; items: readonly { id: string; label: string; detail: string }[] }) {
  return <section className={styles.section}><h2>{title}</h2>{note && <p className={dashboardStyles.chartNote}>{note}</p>}{items.length ? <ul className={styles.list}>
    {items.map((item) => <li key={item.id}><span>{item.label}</span><strong>{item.detail}</strong></li>)}
  </ul> : <p className={styles.muted}>Sin datos para los filtros elegidos.</p>}</section>;
}
function BarChart({ title, description, items }: { title: string; description: string; items: readonly { id: string; label: string; value: string; detail?: string; tone?: 'expense' | 'purchase' }[] }) {
  const widths = moneyChartWidths(items.map(item => item.value));
  return <section className={styles.section} aria-label={title}>
    <h2>{title}</h2><p className={dashboardStyles.chartNote}>{description}</p>
    {items.length ? <dl className={dashboardStyles.chartRows}>{items.map((item, index) => <div key={item.id} className={dashboardStyles.chartRow}>
      <dt>{item.label}{item.detail && <span>{item.detail}</span>}</dt>
      <dd><Money value={item.value} /></dd>
      <svg className={dashboardStyles.bar} viewBox="0 0 1000 16" preserveAspectRatio="none" aria-hidden="true" focusable="false" data-tone={item.tone}>
        <rect className={dashboardStyles.barTrack} width="1000" height="16" rx="4" />
        <rect className={dashboardStyles.barFill} width={widths[index]} height="16" rx="4" />
      </svg>
    </div>)}</dl> : <p className={dashboardStyles.emptyChart}>Todavía no hay datos para este período. Probá otra fecha o sucursal.</p>}
  </section>;
}

export function DashboardWorkspace({ organizationId, role, branches, timezone, currency, load = loadDashboard, now = new Date() }: {
  organizationId: string; role: Role; branches: readonly Branch[]; timezone: string; currency?: string | undefined;
  load?: (organizationId: string, filters: DashboardFilters) => Promise<DashboardData>; now?: Date;
}) {
  const [branchId, setBranchId] = useState('');
  const [period, setPeriod] = useState<DashboardPreset | 'custom' | 'all'>('day');
  const [appliedRange, setAppliedRange] = useState<DashboardRange | null>(() => dashboardPeriodRange('day', timezone, now));
  const [customRange, setCustomRange] = useState<DashboardRange>(() => dashboardPeriodRange('day', timezone, now));
  const [rangeError, setRangeError] = useState<string | null>(null);
  const filters: DashboardFilters = { ...(branchId ? { branchId } : {}),
    ...(role !== 'EMPLOYEE' && appliedRange ? dashboardRangeFilters(appliedRange, timezone) : {}) };
  const query = useQuery({ queryKey: ['dashboard', organizationId, filters.branchId, filters.from, filters.to], queryFn: () => load(organizationId, filters) });
  const data = query.error ? undefined : query.data;
  function choosePeriod(choice: DashboardPreset | 'custom' | 'all') {
    setPeriod(choice); setRangeError(null);
    if (choice === 'custom') { setCustomRange(appliedRange ?? dashboardPeriodRange('day', timezone, now)); return; }
    setAppliedRange(choice === 'all' ? null : dashboardPeriodRange(choice, timezone, now));
  }
  function applyCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try { dashboardRangeFilters(customRange, timezone); setAppliedRange(customRange); setRangeError(null); }
    catch (error) { setRangeError(error instanceof Error ? error.message : 'Elegí fechas válidas.'); }
  }
  return <div className={styles.workspace}>
    <header className={`${styles.heading} ${dashboardStyles.heading}`}>
      <div><h1>Resumen de tu negocio</h1><p>{role === 'EMPLOYEE' ? 'Catálogo e inventario de tus sucursales autorizadas.' : role === 'CASHIER' ? 'Tus ventas y sesiones de caja, en un vistazo.' : 'Lo que necesitás saber para organizar tu próxima decisión.'}</p></div>
      <button className={dashboardStyles.refresh} type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>{query.isFetching ? 'Actualizando…' : 'Actualizar'}</button>
    </header>
    <section className={dashboardStyles.periodPanel} aria-label="Filtros del dashboard">
      <div className={dashboardStyles.filterRow}>
        {role !== 'EMPLOYEE' && <div className={dashboardStyles.periodButtons} role="group" aria-label="Período del resumen">{presets.map(item => <button key={item.key} type="button" aria-pressed={period === item.key} onClick={() => choosePeriod(item.key)}>{item.label}</button>)}</div>}
        <div className={`${styles.field} ${dashboardStyles.branchField}`}><label htmlFor="dashboard-branch">Sucursal del dashboard</label><select id="dashboard-branch" value={branchId} onChange={event => setBranchId(event.target.value)}><option value="">Todas las autorizadas</option>{branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div>
      </div>
      {period === 'custom' && role !== 'EMPLOYEE' && <form className={dashboardStyles.customRange} onSubmit={applyCustom} noValidate>
        <div className={styles.field}><label htmlFor="dashboard-from">Desde</label><input id="dashboard-from" type="date" required value={customRange.from} onChange={event => setCustomRange({ ...customRange, from: event.target.value })} aria-invalid={!!rangeError} aria-describedby={rangeError ? 'dashboard-date-hint dashboard-range-error' : 'dashboard-date-hint'} /></div>
        <div className={styles.field}><label htmlFor="dashboard-to">Hasta</label><input id="dashboard-to" type="date" required value={customRange.through} onChange={event => setCustomRange({ ...customRange, through: event.target.value })} aria-invalid={!!rangeError} aria-describedby={rangeError ? 'dashboard-date-hint dashboard-range-error' : 'dashboard-date-hint'} /></div>
        <button className={styles.button} type="submit">Aplicar período</button>
        <p id="dashboard-date-hint" className={dashboardStyles.dateHint}>Incluye ambas fechas. Podés elegir el mismo día en Desde y Hasta.</p>
        {rangeError && <p id="dashboard-range-error" role="alert" className={dashboardStyles.rangeError}>{rangeError}</p>}
      </form>}
      {role !== 'EMPLOYEE' && <p className={dashboardStyles.periodCaption} aria-live="polite">Resumen: <strong>{dashboardRangeLabel(appliedRange)}</strong><span>Zona horaria: {timezone}{currency ? ` · Importes en ${currency}` : ''}</span></p>}
    </section>
    {query.isFetching && <p role="status" className={styles.muted}>{query.isPending ? 'Cargando dashboard…' : 'Actualizando resumen…'}</p>}
    {query.error && <><ErrorSummary error={query.error instanceof ApiProblemError ? query.error : new ApiProblemError({ status: 0, code: 'DASHBOARD_LOAD_FAILED', message: 'No pudimos cargar el dashboard. Intentá nuevamente.' })} /><button className={styles.button} type="button" onClick={() => void query.refetch()}>Reintentar</button></>}
    {data?.role === 'EMPLOYEE' && <div className={styles.sections}><section className={styles.section}><h2>Catálogo e inventario</h2><p>{data.catalog.length} ítems activos · {data.inventory.length} existencias en sucursales autorizadas.</p>{data.catalog.length ? <ul className={styles.list}>{data.catalog.map(item => <li key={item.itemId}>{item.name}</li>)}</ul> : <p>Sin ítems activos.</p>}</section>
      <section className={styles.section}><h2>Existencias</h2>{data.inventory.length ? <ul className={styles.list}>{data.inventory.map(item => <li key={`${item.branchId}:${item.itemId}`}><span>{data.catalog.find(entry => entry.itemId === item.itemId)?.name ?? item.itemId} · {branches.find(branch => branch.id === item.branchId)?.name ?? item.branchId}</span><strong>{item.quantity}</strong></li>)}</ul> : <p>Sin existencias para las sucursales autorizadas.</p>}</section></div>}
    {data && data.role !== 'EMPLOYEE' && <>
      <dl className={`${styles.metrics} ${dashboardStyles.metrics}`}>
        <div className={styles.metric}><dt>Ventas netas</dt><dd><Money value={data.sales.net} /></dd></div>
        <div className={styles.metric}><dt>Cantidad de ventas</dt><dd>{data.sales.count}</dd></div>
        <div className={styles.metric}><dt>Ticket promedio</dt><dd><Money value={data.sales.averageTicket} /></dd></div>
        {data.role !== 'CASHIER' && <><div className={styles.metric}><dt>Gastos netos</dt><dd><Money value={data.expenses.net} /></dd></div><div className={styles.metric}><dt>Compras netas</dt><dd><Money value={data.purchases.net} /></dd></div><div className={styles.metric}><dt>Resultado operativo</dt><dd><Money value={data.operatingResult.amount} /></dd></div></>}
      </dl>
      {data.role !== 'CASHIER' && <>
        <p className={dashboardStyles.resultNote}>Resultado operativo = ventas netas menos gastos netos. Las compras se muestran por separado.</p>
        <div className={dashboardStyles.charts}>
          <BarChart title="Actividad del período" description="Comparación de importes netos para las fechas elegidas." items={[
            { id: 'sales', label: 'Ventas', value: data.sales.net }, { id: 'expenses', label: 'Gastos', value: data.expenses.net, tone: 'expense' }, { id: 'purchases', label: 'Compras', value: data.purchases.net, tone: 'purchase' },
          ]} />
          <BarChart title="Medios de pago" description="Importes aplicados a ventas, agrupados por medio de pago." items={data.paymentMethods.map(item => ({ id: item.method, label: methodNames[item.method] ?? item.method, value: item.total }))} />
          <BarChart title="Más vendidos" description="Importe vendido por ítem. Ordenado por cantidad vendida." items={data.topItems.map(item => ({ id: item.itemId, label: item.name, detail: `Cantidad: ${item.quantity}`, value: item.total }))} />
        </div>
        <div className={styles.sections}>
          <ListSection title="Stock bajo" note="Existencias actuales de las sucursales elegidas; no dependen del período." items={data.lowStock.map(item => ({ id: `${item.branchId}:${item.itemId}`, label: item.name, detail: `${item.quantity} de mínimo ${item.minimum}` }))} />
          <ListSection title="Resumen de cajas" note="Sesiones abiertas dentro del período seleccionado." items={data.cashSummary.map(item => ({ id: `${item.branchId}:${item.status}`, label: `${branches.find(branch => branch.id === item.branchId)?.name ?? item.branchId} · ${item.status}`, detail: `${item.count} sesiones · ${formatDashboardAmount(item.expectedCash)}` }))} />
        </div>
      </>}
      {data.role === 'CASHIER' && <ListSection title="Mis sesiones de caja" items={data.cashSessions.map(item => ({ id: item.id, label: item.status, detail: formatDashboardAmount(item.expectedCash) }))} />}
    </>}
  </div>;
}
