'use client';
import { useState } from 'react';
import { z } from 'zod';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import { CashCommandRetry, cashRejectionIsDefinitive } from '../cash/cash-api';
import { ErrorSummary } from '../../components/error-summary';
import { useIdentityContext } from './identity-context';
import styles from './management.module.css';

const count = z.string().regex(/^\d+$/);
const blockersSchema = z.strictObject({ sessions: count, pending: count, conflicts: count, uncertainty: count });
const resultSchema = z.object({ id: z.string(), name: z.string(), status: z.literal('INACTIVE'), version: z.number().int() });
const client = new ApiClient();
export async function loadBranchBlockers(organizationId: string, branchId: string) {
  const result = await client.request(`/branches/${encodeURIComponent(branchId)}/deactivation-blockers`, { method: 'GET', organizationId, parse: v => blockersSchema.parse(v) });
  if (!result) throw new Error('Empty branch blockers');
  return result;
}
export async function deactivateBranch(organizationId: string, branchId: string, version: number) {
  const retry = new CashCommandRetry(`branch:${organizationId}:${branchId}`);
  const key = await retry.key('deactivate', { branchId, version });
  try {
    const csrf = await client.request('/auth/csrf', { method: 'GET', parse: v => z.object({ csrfToken: z.string() }).parse(v) });
    if (!csrf) throw new Error('CSRF unavailable');
    const result = await client.request(`/branches/${encodeURIComponent(branchId)}/deactivate`, { method: 'POST', organizationId,
      idempotencyKey: key, ifMatch: `"${version}"`, csrfToken: csrf.csrfToken, body: {}, parse: v => resultSchema.parse(v) });
    if (!result) throw new Error('Empty deactivation response');
    retry.complete('deactivate');
    if (useIdentityContext.getState().activeBranchId === branchId) useIdentityContext.getState().setActiveBranchId(null);
    return result;
  } catch (cause) { if (cashRejectionIsDefinitive(cause)) retry.complete('deactivate'); throw cause; }
}

export function BranchDeactivation({ organizationId, branch, onBlockers = loadBranchBlockers, onDeactivate = deactivateBranch, onReload }: {
  organizationId: string; branch: { id: string; name: string; version: number };
  onBlockers?: typeof loadBranchBlockers; onDeactivate?: typeof deactivateBranch; onReload: () => void;
}) {
  const [blockers, setBlockers] = useState<z.infer<typeof blockersSchema> | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  async function review() {
    setBusy(true); setError(null); setConfirmed(false);
    try { setBlockers(await onBlockers(organizationId, branch.id)); }
    catch { setError(new ApiProblemError({ status: 0, code: 'BLOCKERS_UNAVAILABLE', message: 'No pudimos verificar la sucursal. Reintentá la revisión.' })); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!confirmed || !blockers || Object.values(blockers).some(v => v !== '0')) return;
    setBusy(true); setError(null);
    try { await onDeactivate(organizationId, branch.id, branch.version); setDone(true); onReload(); }
    catch (cause) {
      setError(cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0, code: 'REQUEST_FAILED', message: 'No recibimos la confirmación. Reintentá con los mismos datos.' }));
      if (cause instanceof ApiProblemError && cause.code === 'BRANCH_DEACTIVATION_BLOCKED') {
        setConfirmed(false); setBlockers(null);
        try { setBlockers(await onBlockers(organizationId, branch.id)); } catch { /* Keep manual review available. */ }
      }
      if (cause instanceof ApiProblemError && cause.code === 'BRANCH_VERSION_CONFLICT') { setBlockers(null); setConfirmed(false); onReload(); }
    } finally { setBusy(false); }
  }
  const blocked = blockers && Object.values(blockers).some(v => v !== '0');
  if (done) return <p role="status">{branch.name} desactivada. El historial se conserva.</p>;
  return <div>
    <ErrorSummary error={error} />
    <button type="button" disabled={busy} onClick={() => void review()}>{busy ? 'Verificando…' : `Revisar desactivación de ${branch.name}`}</button>
    {blockers ? <section aria-label={`Desactivación de ${branch.name}`}>
      <p>El historial se conserva. Una sucursal inactiva no admite nuevas operaciones.</p>
      {blocked ? <><p role="status">La sucursal tiene bloqueos pendientes.</p><ul className={styles.branchBlockers}>
        {blockers.sessions !== '0' ? <li>Sesiones abiertas o con conflicto: {blockers.sessions}. <a href="/workspace/cash-sessions">Revisar sesiones de caja</a></li> : null}
        {blockers.pending !== '0' ? <li>Operaciones pendientes: {blockers.pending}. <a href="/workspace/offline">Sincronizar equipos</a></li> : null}
        {blockers.conflicts !== '0' ? <li>Conflictos de inventario: {blockers.conflicts}. <a href="/workspace/inventory">Revisar inventario</a></li> : null}
        {blockers.uncertainty !== '0' ? <li>Incertidumbre offline: {blockers.uncertainty}. Sincronizá todos los equipos y completá la barrera de configuración. El vencimiento o la revocación no eliminan este bloqueo.</li> : null}
      </ul></> : <><p>No se detectaron bloqueos. Se verificarán otra vez al confirmar.</p>
        <div className={styles.checks}><label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />Confirmo la desactivación de {branch.name}.</label></div>
        <button type="button" disabled={busy || !confirmed} onClick={() => void submit()}>Desactivar {branch.name}</button></>}
    </section> : null}
  </div>;
}
