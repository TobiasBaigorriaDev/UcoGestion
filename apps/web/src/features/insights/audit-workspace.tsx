'use client';

import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { loadUserManagement } from '../identity/user-management';
import { auditActionLabel, auditActionLabels, isAutomaticAuditAction } from './audit-labels';
import { loadAudit, type AuditFilters, type AuditPage } from './insights-api';
import styles from './insights.module.css';

export type AuditPerson = { userId: string; email: string };
async function loadAuditPeople(organizationId: string): Promise<AuditPerson[]> {
  const data = await loadUserManagement(organizationId);
  return data.memberships.flatMap(member => member.userId ? [{ userId: member.userId, email: member.email }] : []);
}
const actionOptions = Object.entries(auditActionLabels).sort(([, left], [, right]) => left.localeCompare(right, 'es'));

export function AuditWorkspace({ organizationId, branches, timezone, load = loadAudit, loadPeople = loadAuditPeople }: {
  organizationId: string; branches: readonly { id: string; name: string }[]; timezone: string;
  load?: (organizationId: string, filters: AuditFilters) => Promise<AuditPage>;
  loadPeople?: (organizationId: string) => Promise<AuditPerson[]>;
}) {
  const [draft, setDraft] = useState({ branchId: '', action: '', actorUserId: '' });
  const [filters, setFilters] = useState(draft);
  const [showAutomatic, setShowAutomatic] = useState(false);
  const people = useQuery({ queryKey: ['audit-people', organizationId], queryFn: () => loadPeople(organizationId) });
  const query = useInfiniteQuery({ queryKey: ['audit', organizationId, filters], initialPageParam: '',
    queryFn: ({ pageParam }) => load(organizationId, {
      ...(filters.branchId ? { branchId: filters.branchId } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
    }), getNextPageParam: (page) => page.nextCursor ?? undefined });
  const all = query.data?.pages.flatMap((page) => page.items) ?? [];
  const events = showAutomatic ? all : all.filter(item => !isAutomaticAuditAction(item.action));
  const hidden = all.length - events.length;
  const person = (userId: string) => people.data?.find(entry => entry.userId === userId)?.email ?? 'Otra persona';
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setFilters(draft); }
  return <div className={styles.workspace}>
    <header className={styles.heading}><h1>Auditoría</h1><p>Quién hizo qué y cuándo, en las sucursales que podés ver.</p></header>
    <form className={styles.filters} onSubmit={submit}>
      <div className={styles.field}><label htmlFor="audit-action">Qué pasó</label><select id="audit-action" value={draft.action}
        onChange={(event) => setDraft({ ...draft, action: event.target.value })}><option value="">Todas las acciones</option>
        {actionOptions.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></div>
      <div className={styles.field}><label htmlFor="audit-actor">Persona</label><select id="audit-actor" value={draft.actorUserId}
        onChange={(event) => setDraft({ ...draft, actorUserId: event.target.value })}><option value="">Todas las personas</option>
        {(people.data ?? []).map(entry => <option key={entry.userId} value={entry.userId}>{entry.email}</option>)}</select></div>
      {branches.length > 1 ? <div className={styles.field}><label htmlFor="audit-branch">Sucursal</label><select id="audit-branch" value={draft.branchId}
        onChange={(event) => setDraft({ ...draft, branchId: event.target.value })}><option value="">Todas las autorizadas</option>
        {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div> : null}
      <button className={styles.button} type="submit">Aplicar filtros</button>
    </form>
    <label className={styles.toggle}><input type="checkbox" checked={showAutomatic} onChange={(event) => setShowAutomatic(event.target.checked)} />
      Mostrar también tareas automáticas del sistema</label>
    {query.isPending && <p role="status">Cargando auditoría…</p>}
    {query.error && <><ErrorSummary error={query.error instanceof ApiProblemError ? query.error : new ApiProblemError({ status: 0, code: 'AUDIT_LOAD_FAILED', message: 'No pudimos cargar la auditoría. Intentá nuevamente.' })} /><button type="button" className={styles.button} onClick={() => void query.refetch()}>Reintentar</button></>}
    {query.data && <section className={styles.section}><h2>Movimientos registrados</h2>
      {events.length ? <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th scope="col">Fecha</th><th scope="col">Qué pasó</th><th scope="col">Persona</th><th scope="col">Sucursal</th></tr></thead>
        <tbody>{events.map((item) => <tr key={item.id}>
          <td data-label="Fecha"><time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString('es-AR', { timeZone: timezone })}</time></td>
          <td data-label="Qué pasó">{auditActionLabel(item.action)}</td>
          <td data-label="Persona">{person(item.actorUserId)}</td>
          <td data-label="Sucursal">{branches.find((branch) => branch.id === item.branchId)?.name ?? (item.branchId ? 'Otra sucursal' : 'Todo el negocio')}</td>
        </tr>)}</tbody></table></div> : <p>{hidden ? 'Solo hay tareas automáticas en esta página.' : 'Sin movimientos para los filtros elegidos.'}</p>}
      {query.hasNextPage && <button type="button" className={styles.button} disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Cargando…' : 'Cargar más eventos'}</button>}
    </section>}
  </div>;
}
