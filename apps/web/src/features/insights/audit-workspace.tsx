'use client';

import { useState, type FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { loadAudit, type AuditFilters, type AuditPage } from './insights-api';
import styles from './insights.module.css';

export function AuditWorkspace({ organizationId, branches, timezone, load = loadAudit }: {
  organizationId: string; branches: readonly { id: string; name: string }[]; timezone: string;
  load?: (organizationId: string, filters: AuditFilters) => Promise<AuditPage>;
}) {
  const [draft, setDraft] = useState({ branchId: '', action: '', actorUserId: '' });
  const [filters, setFilters] = useState(draft);
  const query = useInfiniteQuery({ queryKey: ['audit', organizationId, filters], initialPageParam: '',
    queryFn: ({ pageParam }) => load(organizationId, {
      ...(filters.branchId ? { branchId: filters.branchId } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
    }), getNextPageParam: (page) => page.nextCursor ?? undefined });
  const events = query.data?.pages.flatMap((page) => page.items) ?? [];
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setFilters(draft); }
  return <div className={styles.workspace}>
    <header className={styles.heading}><h1>Auditoría</h1><p>Eventos disponibles según tu rol y las sucursales asignadas.</p></header>
    <form className={styles.filters} onSubmit={submit}>
      <div className={styles.field}><label htmlFor="audit-branch">Sucursal</label><select id="audit-branch" value={draft.branchId} onChange={(event) => setDraft({ ...draft, branchId: event.target.value })}><option value="">Todas las autorizadas</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div>
      <div className={styles.field}><label htmlFor="audit-action">Acción exacta</label><input id="audit-action" value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })} /></div>
      <div className={styles.field}><label htmlFor="audit-actor">ID de usuario actor</label><input id="audit-actor" value={draft.actorUserId} onChange={(event) => setDraft({ ...draft, actorUserId: event.target.value })} /></div>
      <button className={styles.button} type="submit">Aplicar filtros</button>
    </form>
    {query.isPending && <p role="status">Cargando auditoría…</p>}
    {query.error && <><ErrorSummary error={query.error instanceof ApiProblemError ? query.error : new ApiProblemError({ status: 0, code: 'AUDIT_LOAD_FAILED', message: 'No pudimos cargar la auditoría. Intentá nuevamente.' })} /><button type="button" className={styles.button} onClick={() => void query.refetch()}>Reintentar</button></>}
    {query.data && <section className={styles.section}><h2>Eventos</h2>
      {events.length ? <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th scope="col">Fecha</th><th scope="col">Acción</th><th scope="col">Entidad</th><th scope="col">Actor</th><th scope="col">Sucursal</th></tr></thead><tbody>{events.map((item) => <tr key={item.id}><td data-label="Fecha"><time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString('es-AR', { timeZone: timezone })}</time></td><td data-label="Acción">{item.action}</td><td data-label="Entidad">{item.entityType} · {item.entityId}</td><td data-label="Actor">{item.actorUserId}</td><td data-label="Sucursal">{branches.find((branch) => branch.id === item.branchId)?.name ?? (item.branchId ? item.branchId : 'Global')}</td></tr>)}</tbody></table></div> : <p>Sin eventos para los filtros elegidos.</p>}
      {query.hasNextPage && <button type="button" className={styles.button} disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Cargando…' : 'Cargar más eventos'}</button>}
    </section>}
  </div>;
}
