'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { loadDashboard, startOfDayInTimezone, type DashboardData, type DashboardFilters } from './insights-api';
import styles from './insights.module.css';

type Role = 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
type Branch = { id: string; name: string };
const methodNames: Record<string, string> = { CASH: 'Efectivo', CARD: 'Tarjeta', TRANSFER: 'Transferencia' };
function Money({ value }: { value: string }) { return <span>{value}</span>; }
function ListSection({ title, items }: { title: string; items: readonly { id: string; label: string; detail: string }[] }) {
  return <section className={styles.section}><h2>{title}</h2>{items.length ? <ul className={styles.list}>
    {items.map((item) => <li key={item.id}><span>{item.label}</span><strong>{item.detail}</strong></li>)}
  </ul> : <p className={styles.muted}>Sin datos para los filtros elegidos.</p>}</section>;
}

export function DashboardWorkspace({ organizationId, role, branches, timezone, load = loadDashboard }: {
  organizationId: string; role: Role; branches: readonly Branch[]; timezone: string;
  load?: (organizationId: string, filters: DashboardFilters) => Promise<DashboardData>;
}) {
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filters: DashboardFilters = { ...(branchId ? { branchId } : {}),
    ...(from ? { from: startOfDayInTimezone(from, timezone) } : {}),
    ...(to ? { to: startOfDayInTimezone(to, timezone) } : {}) };
  const invalidPeriod = !!from && !!to && from >= to;
  const query = useQuery({ queryKey: ['dashboard', organizationId, filters.branchId, filters.from, filters.to],
    queryFn: () => load(organizationId, filters), enabled: !invalidPeriod });
  const data = query.data;
  return <div className={styles.workspace}>
    <header className={styles.heading}><h1>Dashboard</h1><p>Resumen de la operación dentro de tu alcance.</p></header>
    <div className={styles.filters} role="group" aria-label="Filtros del dashboard">
      <div className={styles.field}><label htmlFor="dashboard-branch">Sucursal del dashboard</label><select id="dashboard-branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">Todas las autorizadas</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div>
      {role !== 'EMPLOYEE' && <><div className={styles.field}><label htmlFor="dashboard-from">Desde ({timezone})</label><input id="dashboard-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></div><div className={styles.field}><label htmlFor="dashboard-to">Hasta (exclusivo)</label><input id="dashboard-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></div></>}
    </div>
    {invalidPeriod && <p role="alert">La fecha Hasta debe ser posterior a Desde.</p>}
    {query.isPending && !invalidPeriod && <p role="status">Cargando dashboard…</p>}
    {query.error && <><ErrorSummary error={query.error instanceof ApiProblemError ? query.error : new ApiProblemError({ status: 0, code: 'DASHBOARD_LOAD_FAILED', message: 'No pudimos cargar el dashboard. Intentá nuevamente.' })} /><button className={styles.button} type="button" onClick={() => void query.refetch()}>Reintentar</button></>}
    {data?.role === 'EMPLOYEE' && <div className={styles.sections}><section className={styles.section}><h2>Catálogo e inventario</h2><p>{data.catalog.length} ítems activos · {data.inventory.length} existencias en sucursales autorizadas.</p>{data.catalog.length ? <ul className={styles.list}>{data.catalog.map((item) => <li key={item.itemId}>{item.name}</li>)}</ul> : <p>Sin ítems activos.</p>}</section>
      <section className={styles.section}><h2>Existencias</h2>{data.inventory.length ? <ul className={styles.list}>{data.inventory.map((item) => <li key={`${item.branchId}:${item.itemId}`}><span>{data.catalog.find((entry) => entry.itemId === item.itemId)?.name ?? item.itemId} · {branches.find((branch) => branch.id === item.branchId)?.name ?? item.branchId}</span><strong>{item.quantity}</strong></li>)}</ul> : <p>Sin existencias para las sucursales autorizadas.</p>}</section></div>}
    {data && data.role !== 'EMPLOYEE' && <>
      <dl className={styles.metrics}><div className={styles.metric}><dt>Ventas netas</dt><dd><Money value={data.sales.net} /></dd></div><div className={styles.metric}><dt>Cantidad de ventas</dt><dd>{data.sales.count}</dd></div><div className={styles.metric}><dt>Ticket promedio</dt><dd><Money value={data.sales.averageTicket} /></dd></div>
      {data.role !== 'CASHIER' && <><div className={styles.metric}><dt>Gastos netos</dt><dd>{data.expenses.net}</dd></div><div className={styles.metric}><dt>Compras netas</dt><dd>{data.purchases.net}</dd></div><div className={styles.metric}><dt>Resultado operativo</dt><dd>{data.operatingResult.amount}</dd></div></>}</dl>
      {data.role !== 'CASHIER' && <><p className={styles.muted}>Resultado operativo = ventas netas menos gastos netos.</p><div className={styles.sections}>
        <ListSection title="Medios de pago" items={data.paymentMethods.map((item) => ({ id: item.method, label: methodNames[item.method] ?? item.method, detail: item.total }))} />
        <ListSection title="Más vendidos" items={data.topItems.map((item) => ({ id: item.itemId, label: item.name, detail: `${item.quantity} unidades · ${item.total}` }))} />
        <ListSection title="Stock bajo" items={data.lowStock.map((item) => ({ id: `${item.branchId}:${item.itemId}`, label: item.name, detail: `${item.quantity} de mínimo ${item.minimum}` }))} />
        <ListSection title="Resumen de cajas" items={data.cashSummary.map((item) => ({ id: `${item.branchId}:${item.status}`, label: `${branches.find((branch) => branch.id === item.branchId)?.name ?? item.branchId} · ${item.status}`, detail: `${item.count} sesiones · ${item.expectedCash}` }))} />
      </div></>}
      {data.role === 'CASHIER' && <ListSection title="Mis sesiones de caja" items={data.cashSessions.map((item) => ({ id: item.id, label: item.status, detail: item.expectedCash }))} />}
    </>}
  </div>;
}
