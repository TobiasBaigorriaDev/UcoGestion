'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { downloadReportCsv, loadReport, loadReportExport, queueReportExport,
  type ReportDataset, type ReportFilters, type ReportPage } from './insights-api';
import type { ReportExport } from './insights-api';
import styles from './insights.module.css';

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
  queueExport = queueReportExport, loadExport = loadReportExport, downloadCsv = downloadReportCsv }: {
  organizationId: string; role: Role; branches: readonly { id: string; name: string }[]; timezone: string;
  load?: (organizationId: string, dataset: ReportDataset, filters: ReportFilters) => Promise<ReportPage>;
  queueExport?: (organizationId: string, dataset: ReportDataset, filters: Omit<ReportFilters, 'cursor'>, key: string) => Promise<ReportExport>;
  loadExport?: (organizationId: string, id: string) => Promise<ReportExport>;
  downloadCsv?: (organizationId: string, dataset: ReportDataset, filters: Omit<ReportFilters, 'cursor'>) => Promise<void>;
}) {
  const datasets = allowedDatasets(role);
  const [dataset, setDataset] = useState<ReportDataset>(datasets[0]!);
  const [draft, setDraft] = useState({ branchId: '', from: '', to: '', status: '', lowStock: '' });
  const [filters, setFilters] = useState<ReportFilters>({});
  const [exportId, setExportId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'csv' | 'pdf' | null>(null);
  const exportKey = useRef<string | null>(null);
  const invalidPeriod = !!draft.from && !!draft.to && draft.from >= draft.to;
  const query = useInfiniteQuery({ queryKey: ['report', organizationId, dataset, filters], initialPageParam: '',
    queryFn: ({ pageParam }) => load(organizationId, dataset, { ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined });
  const exportStatus = useQuery({ queryKey: ['report-export', organizationId, exportId],
    queryFn: () => loadExport(organizationId, exportId!), enabled: !!exportId,
    refetchInterval: (query) => query.state.data?.status === 'QUEUED' || query.state.data?.status === 'PROCESSING' ? 3000 : false });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (invalidPeriod) return;
    setFilters(Object.fromEntries(Object.entries(draft).filter(([, value]) => value)));
    setExportId(null); exportKey.current = null;
  }
  function switchDataset(value: ReportDataset) {
    setDataset(value); setDraft({ branchId: draft.branchId, from: '', to: '', status: '', lowStock: '' });
    setFilters({}); setExportId(null); exportKey.current = null;
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
    <header className={styles.heading}><h1>Reportes</h1><p>Datos históricos y exportaciones según tu rol y sucursales autorizadas.</p></header>
    <form className={styles.filters} onSubmit={submit}>
      <div className={styles.field}><label htmlFor="report-dataset">Dataset</label><select id="report-dataset" value={dataset} onChange={(event) => switchDataset(event.target.value as ReportDataset)}>{datasets.map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select></div>
      <div className={styles.field}><label htmlFor="report-branch">Sucursal</label><select id="report-branch" value={draft.branchId} onChange={(event) => setDraft({ ...draft, branchId: event.target.value })}><option value="">Todas las autorizadas</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div>
      {dataset !== 'inventory' && <><div className={styles.field}><label htmlFor="report-from">Desde</label><input id="report-from" type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></div>
      <div className={styles.field}><label htmlFor="report-to">Hasta (exclusivo)</label><input id="report-to" type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></div></>}
      {statuses[dataset] && <div className={styles.field}><label htmlFor="report-status">Estado</label><select id="report-status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}><option value="">Todos</option>{statuses[dataset]?.map((value) => <option key={value} value={value}>{statusLabels[value] ?? value}</option>)}</select></div>}
      {dataset === 'inventory' && <div className={styles.field}><label htmlFor="report-low-stock">Stock bajo</label><select id="report-low-stock" value={draft.lowStock} onChange={(event) => setDraft({ ...draft, lowStock: event.target.value })}><option value="">Todos</option><option value="true">Solo stock bajo</option><option value="false">Sin stock bajo</option></select></div>}
      <button className={styles.button} type="submit">Aplicar filtros</button>
    </form>
    {invalidPeriod && <p role="alert">La fecha Hasta debe ser posterior a Desde.</p>}
    {query.isPending && <p role="status">Cargando reporte…</p>}
    {query.error && <><ErrorSummary error={query.error instanceof ApiProblemError ? query.error : new ApiProblemError({ status: 0, code: 'REPORT_LOAD_FAILED', message: 'No pudimos cargar el reporte. Intentá nuevamente.' })} /><button type="button" className={styles.button} onClick={() => void query.refetch()}>Reintentar</button></>}
    {query.data && <section className={styles.section}><h2>{labels[dataset]}</h2>
      {query.data.pages[0]?.net !== undefined && <p>Importe neto: <strong>{query.data.pages[0].net}</strong>. Las operaciones anuladas permanecen visibles con su estado.</p>}
      {items.length ? <div className={styles.tableWrap}><table className={styles.table}><thead><tr>{fields[dataset].map((field) => <th scope="col" key={field}>{columnLabels[field]}</th>)}</tr></thead><tbody>{items.map((item) => <tr key={`${item.branchId}:${item.id}`}>{fields[dataset].map((field) => <td key={field} data-label={columnLabels[field]}>{field === 'branchId' ? branches.find((branch) => branch.id === item.branchId)?.name ?? item.branchId : displayField(field, item[field], timezone)}</td>)}</tr>)}</tbody></table></div> : <p>Sin registros para los filtros elegidos.</p>}
      {query.hasNextPage && <button type="button" className={styles.button} disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Cargando…' : 'Cargar más registros'}</button>}
    </section>}
    <section className={styles.section}><h2>Exportar datos filtrados</h2><p>CSV y PDF usan los filtros aplicados y el alcance autorizado por el servidor.</p><div className={styles.actions}>
      <button className={styles.button} type="button" disabled={busy !== null || invalidPeriod} onClick={() => void csv()}>{busy === 'csv' ? 'Descargando…' : 'Descargar CSV'}</button>
      <button className={styles.button} type="button" disabled={busy !== null || invalidPeriod} onClick={() => void pdf()}>{busy === 'pdf' ? 'Solicitando…' : 'Generar PDF'}</button>
    </div>
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
