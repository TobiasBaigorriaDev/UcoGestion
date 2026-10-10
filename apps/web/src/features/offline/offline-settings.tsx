'use client';
import { OrganizationTime } from '../../components/organization-time';

import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import type { OfflineStatus } from '../../offline/offline-status';
import styles from '../identity/management.module.css';

const schema = z.object({ pin: z.string().min(8, 'Ingresá un PIN de al menos 8 caracteres.') });
export interface OfflineSettingsActions {
  readonly role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
  readonly configured: boolean;
  readonly deviceAuthorized?: boolean;
  readonly authorize: (pin: string) => Promise<OfflineStatus>;
  readonly unlock: (pin: string) => Promise<OfflineStatus>;
  readonly lock: () => void;
  readonly refresh: () => Promise<OfflineStatus>;
  readonly sync: () => Promise<OfflineStatus>;
  readonly readStatus?: () => Promise<OfflineStatus>;
}
export function OfflineSettings(actions: OfflineSettingsActions) {
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  const [prepared, setPrepared] = useState(actions.configured);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const generation = useRef(0);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  useEffect(() => {
    const retire = () => { generation.current++; actions.lock(); setStatus(null); reset(); };
    const storage = (event: StorageEvent) => { if (event.key === 'uco:identity-retired') retire(); };
    window.addEventListener('uco:identity-retired', retire); window.addEventListener('storage', storage);
    return () => { generation.current++; window.removeEventListener('uco:identity-retired', retire); window.removeEventListener('storage', storage); actions.lock(); };
  }, [actions.lock, reset]);
  useEffect(() => {
    if (!status || !actions.readStatus) return;
    let live = true;
    const current = generation.current;
    const refresh = () => { void actions.readStatus?.().then(next => {
      if (live && current === generation.current) setStatus(next);
    }).catch(() => { if (live && current === generation.current) { actions.lock(); setStatus(null); } }); };
    window.addEventListener('uco:delivery-state', refresh);
    return () => { live = false; window.removeEventListener('uco:delivery-state', refresh); };
  }, [status, actions.readStatus, actions.lock]);
  useEffect(() => {
    if (!status || status.expired) return;
    const delay = Math.max(0, new Date(status.expiresAt).getTime() - Date.now());
    const timer = setTimeout(() => setStatus(current => current ? { ...current, expired: true } : null), Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [status]);
  async function run(operation: () => Promise<OfflineStatus>) {
    const current = generation.current; setBusy(true); setError(null);
    try { const next = await operation(); if (current === generation.current) { setStatus(next); setPrepared(true); } }
    catch { if (current === generation.current) setError(new ApiProblemError({ status: 0, code: 'OFFLINE_ACTION_FAILED',
      message: 'No pudimos completar la acción. Verificá el PIN y la conexión. Si el PIN está bloqueado, reautenticate online. Los pendientes siguen protegidos.' })); }
    finally { reset(); setBusy(false); }
  }
  const canAuthorize = actions.deviceAuthorized || actions.role === 'OWNER' || actions.role === 'ADMIN';
  return <section className={styles.page} aria-labelledby="offline-heading">
    <header className={styles.heading}><h1 id="offline-heading">POS sin conexión</h1><p>Prepará este equipo online. El PIN desbloquea únicamente tus datos y operaciones.</p></header>
    <ErrorSummary error={error} />
    {actions.role === 'EMPLOYEE' ? <p role="alert">Tu rol no permite operar el POS offline.</p> : <>
      {!status ? <form className={styles.panel} noValidate onSubmit={handleSubmit(({ pin }) => run(() => prepared ? actions.unlock(pin) : actions.authorize(pin)))}>
        <h2>{prepared ? 'Desbloquear datos' : 'Preparar este equipo'}</h2>
        {!prepared && !canAuthorize ? <p>Pedile a OWNER o ADMIN que autorice este equipo para esta sucursal.</p> : <>
          <label htmlFor="offline-pin">PIN offline</label>
          <input id="offline-pin" type="password" autoComplete={prepared ? 'current-password' : 'new-password'} aria-invalid={!!errors.pin} aria-describedby={errors.pin ? 'offline-pin-error' : 'offline-pin-help'} {...register('pin')} />
          <p id="offline-pin-help">Al menos 8 caracteres. No uses tu contraseña de acceso.</p>
          {errors.pin ? <p id="offline-pin-error" role="alert">{errors.pin.message}</p> : null}
          <button type="submit" disabled={busy}>{busy ? 'Verificando…' : prepared ? 'Desbloquear mi identidad' : 'Autorizar este equipo y crear PIN'}</button>
        </>}
      </form> : <>
        <section className={styles.panel} aria-labelledby="offline-validity"><h2 id="offline-validity">Autorización y sincronización</h2>
          <p role="status">{status.expired ? 'Autorización vencida. Conectate y renovala antes de abrir caja o vender.' : 'Autorización vigente para operar sin conexión.'}</p>
          <dl><dt>Vigente hasta</dt><dd><OrganizationTime value={status.expiresAt} timezone={status.timezone} /></dd>
            <dt>Última validación y sincronización</dt><dd><OrganizationTime value={status.lastSyncAt} timezone={status.timezone} /></dd></dl>
          <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void run(actions.sync)}>Sincronizar mis pendientes</button>
            <button type="button" disabled={busy} onClick={() => void run(actions.refresh)}>Renovar autorización online</button>
            <button type="button" onClick={() => { generation.current++; actions.lock(); setStatus(null); reset(); }}>Bloquear datos offline</button></div>
        </section>
        <section className={styles.panel} aria-labelledby="offline-pending"><h2 id="offline-pending">Mis operaciones pendientes</h2>
          <p>Se conservan protegidas hasta recibir la confirmación del servidor. Podés reintentar sin duplicarlas.</p>
          {status.pending.length ? <ul className={styles.rows}>{status.pending.map(row => <li className={styles.row} key={row.id}>
            <strong>{row.kind === 'sale-confirm' ? 'Venta' : row.kind === 'cash-session-open' ? 'Apertura de caja' : 'Operación'}</strong>
            <span>{row.id}</span><span>Secuencia {row.sequence} · Pendiente de confirmación</span><OrganizationTime value={row.occurredAt} timezone={status.timezone} />
          </li>)}</ul> : <p>No tenés operaciones pendientes.</p>}
        </section>
      </>}
    </>}
  </section>;
}
