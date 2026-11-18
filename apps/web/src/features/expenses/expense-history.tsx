'use client';

import { useEffect, useState } from 'react';

import { OrganizationTime } from '../../components/organization-time';
import { formatMoney, paymentMethodLabel } from '../../lib/format';
import type { ReportFilters, ReportPage } from '../insights/insights-api';
import styles from './expense-history.module.css';

export type ExpenseHistoryLoader = (organizationId: string, filters: ReportFilters) => Promise<ReportPage>;
type Row = { id: string; concept: string; categoryName: string; amount: string; method: string; currencyCode: string;
  status: string; occurredAt: string };
type Filters = { from: string; to: string; status: string };

function rowsOf(page: ReportPage): Row[] {
  return page.items.map(item => ({ id: item.id, concept: String(item.concept ?? ''), categoryName: String(item.categoryName ?? ''),
    amount: String(item.amount ?? '0.00'), method: String(item.method ?? ''), currencyCode: String(item.currencyCode ?? 'ARS'),
    status: String(item.status ?? ''), occurredAt: String(item.occurredAt ?? '') }));
}

/** Branch expense history for owners and admins, read from the authorized expenses report. */
export function ExpenseHistory({ organizationId, branchId, load, onOpen, refresh }: {
  organizationId: string; branchId: string; load: ExpenseHistoryLoader; onOpen: (id: string) => void; refresh: number;
}) {
  const [draft, setDraft] = useState<Filters>({ from: '', to: '', status: '' });
  const [filters, setFilters] = useState<Filters>(draft);
  const [rows, setRows] = useState<Row[]>([]);
  const [net, setNet] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const base = (cursor?: string): ReportFilters => ({ branchId, ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}), ...(filters.status ? { status: filters.status } : {}), ...(cursor ? { cursor } : {}) });
  useEffect(() => {
    let current = true;
    setState('loading');
    load(organizationId, base()).then(page => {
      if (!current) return;
      setRows(rowsOf(page)); setNet(page.net ?? null); setNext(page.nextCursor); setState('ready');
    }).catch(() => { if (current) setState('failed'); });
    return () => { current = false; };
  }, [organizationId, branchId, filters, load, refresh]);
  async function more() {
    if (!next) return;
    try {
      const page = await load(organizationId, base(next));
      setRows(previous => [...previous, ...rowsOf(page)]); setNext(page.nextCursor);
    } catch { setState('failed'); }
  }
  const change = (patch: Partial<Filters>) => { const value = { ...draft, ...patch }; setDraft(value); if ('status' in patch) setFilters(value); };
  return <section className={styles.history} aria-label="Historial de gastos">
    <h2>Historial de gastos</h2>
    <form className={styles.filters} onSubmit={event => { event.preventDefault(); setFilters(draft); }}>
      <div><label htmlFor="expense-history-from">Desde</label><input id="expense-history-from" type="date" value={draft.from}
        onChange={event => change({ from: event.target.value })} /></div>
      <div><label htmlFor="expense-history-to">Hasta</label><input id="expense-history-to" type="date" value={draft.to}
        onChange={event => change({ to: event.target.value })} /></div>
      <div><label htmlFor="expense-history-status">Estado del gasto</label><select id="expense-history-status" value={draft.status}
        onChange={event => change({ status: event.target.value })}>
        <option value="">Todos</option><option value="CONFIRMED">Vigentes</option><option value="CANCELLED">Anulados</option></select></div>
      <button type="submit">Aplicar fechas</button>
    </form>
    {state === 'loading' ? <p role="status">Cargando gastos…</p> : null}
    {state === 'failed' ? <p>No pudimos cargar el historial. <button type="button" onClick={() => setFilters({ ...filters })}>Reintentar</button></p> : null}
    {state === 'ready' && net !== null ? <dl className={styles.total}><dt>Total del período</dt><dd>{formatMoney(net, rows[0]?.currencyCode ?? 'ARS')}</dd></dl> : null}
    {state === 'ready' && !rows.length ? <p className={styles.empty}>No hay gastos con estos filtros.</p> : null}
    {rows.length ? <ul className={styles.list}>{rows.map(item => <li key={item.id}>
      <button type="button" className={styles.row} onClick={() => onOpen(item.id)}>
        <span className={styles.main}><strong>{item.concept}</strong>
          <span>{item.categoryName} · {paymentMethodLabel(item.method)} · {item.occurredAt ? <OrganizationTime value={item.occurredAt} /> : null}</span></span>
        <span className={styles.side}><strong className={styles.amount}>{formatMoney(item.amount, item.currencyCode)}</strong>
          {item.status === 'CANCELLED' ? <span className={styles.cancelled}>Anulado</span> : null}</span>
      </button>
    </li>)}</ul> : null}
    {next ? <button type="button" onClick={() => void more()}>Ver más gastos</button> : null}
  </section>;
}
