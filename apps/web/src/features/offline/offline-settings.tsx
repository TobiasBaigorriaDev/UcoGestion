'use client';
import { OrganizationTime } from '../../components/organization-time';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import type { OfflineStatus } from '../../offline/offline-status';
import styles from '../identity/management.module.css';
import { OfflinePinChange } from './offline-pin-change';

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
  readonly changePin?: (currentPin: string, newPin: string) => Promise<void>;
  readonly renderPos?: (status: OfflineStatus) => ReactNode;
}
export function OfflineSettings(actions: OfflineSettingsActions) {
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  const [prepared, setPrepared] = useState(actions.configured);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [changingPin, setChangingPin] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const changePinButton = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  useEffect(() => {
    const retire = () => { generation.current++; actions.lock(); setStatus(null); setChangingPin(false); setNotice(null); reset(); };
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
  async function run(operation: () => Promise<OfflineStatus>, action: 'pin' | 'sync' | 'refresh' = 'pin') {
    const current = generation.current; setBusy(true); setError(null);
    try { const next = await operation(); if (current === generation.current) { setStatus(next); setPrepared(true); } }
    catch { if (current === generation.current) setError(new ApiProblemError({ status: 0, code: 'OFFLINE_ACTION_FAILED',
      message: action === 'sync'
        ? 'No pudimos sincronizar los pendientes. Revisá la conexión y reintentá. Si continúa, el servidor no pudo procesar la entrega. Los pendientes siguen protegidos.'
        : action === 'refresh'
          ? 'No pudimos renovar la autorización. Revisá la conexión y tu sesión online. Primero deben sincronizarse todos los pendientes. Los pendientes siguen protegidos.'
          : 'No pudimos completar la acción. Verificá el PIN y la conexión. Si el PIN está bloqueado, reautenticate online. Los pendientes siguen protegidos.' })); }
    finally { reset(); setBusy(false); }
  }
  async function changePin(currentPin: string, newPin: string) {
    if (!actions.changePin) return;
    const current = generation.current; setBusy(true); setError(null); setNotice(null);
    try {
      await actions.changePin(currentPin, newPin);
      if (current === generation.current) {
        setChangingPin(false); setNotice('PIN offline actualizado. Tus datos y pendientes se conservaron.');
        changePinButton.current?.focus();
      }
    } catch (failure) {
      if (current === generation.current) {
        actions.lock(); setStatus(null); setChangingPin(false);
        const message = failure instanceof Error && failure.message === 'PIN incorrecto.'
          ? 'PIN actual incorrecto. Tus datos y pendientes siguen protegidos.'
          : 'No pudimos cambiar el PIN. Desbloqueá con tu PIN vigente y reintentá. Si está bloqueado, reautenticate online. Tus datos y pendientes siguen protegidos.';
        setError(new ApiProblemError({ status: 0, code: 'OFFLINE_PIN_CHANGE_FAILED', message }));
      }
    } finally { reset(); setBusy(false); }
  }
  const canAuthorize = actions.deviceAuthorized || actions.role === 'OWNER' || actions.role === 'ADMIN';
  return <section className={styles.page} aria-labelledby="offline-heading">
    <header className={styles.heading}><h1 id="offline-heading">POS sin conexión</h1><p>Prepará este equipo online. El PIN desbloquea únicamente tus datos y operaciones.</p></header>
    <ErrorSummary error={error} />
    {notice ? <p role="status">{notice}</p> : null}
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
        {actions.renderPos?.(status)}
        <section className={styles.panel} aria-labelledby="offline-validity"><h2 id="offline-validity">Autorización y sincronización</h2>
          <p role="status">{status.expired ? 'Autorización vencida. Conectate y renovala antes de abrir caja o vender.' : 'Autorización vigente para operar sin conexión.'}</p>
          <dl><dt>Vigente hasta</dt><dd><OrganizationTime value={status.expiresAt} timezone={status.timezone} /></dd>
            <dt>Última validación y sincronización</dt><dd><OrganizationTime value={status.lastSyncAt} timezone={status.timezone} /></dd></dl>
          <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void run(actions.sync, 'sync')}>Sincronizar mis pendientes</button>
            <button type="button" disabled={busy} onClick={() => void run(actions.refresh, 'refresh')}>Renovar autorización online</button>
            <button type="button" onClick={() => { generation.current++; actions.lock(); setStatus(null); setChangingPin(false); setNotice(null); reset(); }}>Bloquear datos offline</button>
            {actions.changePin ? <button ref={changePinButton} type="button" disabled={busy} aria-expanded={changingPin} aria-controls="offline-pin-change"
              onClick={() => { setChangingPin(value => !value); setNotice(null); setError(null); }}>Cambiar PIN offline</button> : null}</div>
        </section>
        {changingPin ? <OfflinePinChange busy={busy} onChange={changePin} onCancel={() => { setChangingPin(false); changePinButton.current?.focus(); }} /> : null}
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
