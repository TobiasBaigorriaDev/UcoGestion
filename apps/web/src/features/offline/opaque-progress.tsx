'use client';
import { useEffect, useState } from 'react';
import { deliverAllOpaqueDatabases } from '../../offline/opaque-delivery';
import { readOpaqueProgress, type OpaqueProgressState } from '../../offline/opaque-progress';
import styles from '../identity/management.module.css';

export function OpaqueProgress({ load = readOpaqueProgress, deliver = deliverAllOpaqueDatabases }: {
  load?: () => Promise<OpaqueProgressState>; deliver?: () => Promise<void>;
}) {
  const [state, setState] = useState<OpaqueProgressState | null>(null);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () => { void load().then(value => { if (live) setState(value); }).catch(() => { if (live) setFailed(true); }); };
    window.addEventListener('uco:delivery-state', refresh); window.addEventListener('uco:delivery-pending', refresh);
    refresh();
    return () => { live = false; window.removeEventListener('uco:delivery-state', refresh); window.removeEventListener('uco:delivery-pending', refresh); };
  }, [load]);
  async function retry() {
    setBusy(true); setFailed(false);
    try { await deliver(); setState(await load()); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }
  if (!state?.pending && !state?.rejected && !failed) return null;
  return <aside className={`${styles.page} ${styles.opaqueProgress}`} aria-labelledby="opaque-heading"><section className={styles.panel}>
    <h2 id="opaque-heading">Entrega protegida del equipo</h2>
    <p role="status">{busy ? 'Entregando pendientes protegidos…' : `${state?.pending ?? 0} entregas pendientes en este equipo.`}</p>
    <p>Este estado es general. Para revisar tus operaciones o incidencias comerciales, ingresá con tu identidad y abrí su vista correspondiente.</p>
    {state?.rejected ? <p>Hay {state.rejected} entrega(s) con rechazo definitivo. No se reintentan. Contactá a quien administra el equipo.</p> : null}
    {failed ? <p role="alert">La entrega no pudo completarse. Los pendientes siguen protegidos. Revisá la conexión y reintentá.</p> : null}
    <button type="button" disabled={busy || state?.pending === 0} onClick={() => void retry()}>Reintentar entrega del equipo</button>
  </section></aside>;
}
