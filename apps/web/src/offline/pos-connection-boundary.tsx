'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useBusinessOnline } from './online-only-boundary';
import styles from './online-only-boundary.module.css';

/** Keep both modes mounted: offline setup validates while online, and an uncertain
 * online confirmation retains its original idempotency key until retried. */
export function PosConnectionBoundary({ children, offlinePos }: { children: ReactNode; offlinePos: ReactNode }) {
  const online = useBusinessOnline();
  const [local, setLocal] = useState(false);
  const notice = useRef<HTMLDivElement>(null);
  const onlineView = useRef<HTMLDivElement>(null);
  const previouslyBlocked = useRef(false);
  useEffect(() => {
    if (!online || local) notice.current?.focus();
    else if (previouslyBlocked.current) onlineView.current?.focus();
    previouslyBlocked.current = !online || local;
  }, [online, local]);
  return <>
    {!online || local ? <div ref={notice} tabIndex={-1} role={online ? 'status' : 'alert'} className={styles.notice}>
      <h1>{online ? 'Hay conexión a internet' : 'Estás sin internet'}</h1>
      <p>{online ? 'Podés seguir en el mostrador sin conexión o volver al mostrador con internet.' : 'El mostrador con internet está bloqueado. Para nuevas ventas, usá el mostrador sin conexión con tu PIN y la autorización vigente de este equipo.'}</p>
      <p>Si intentaste confirmar una venta y no recibiste respuesta, no la vuelvas a cargar en el mostrador sin conexión. Cuando vuelva internet, reintentá esa misma venta en el mostrador con internet para recuperar el resultado sin duplicarla.</p>
      <p>El carrito online se conserva mientras mantengas esta pantalla abierta. Los pendientes offline siguen protegidos.</p>
      {!local ? <button className={styles.action} type="button" onClick={() => setLocal(true)}>Pasar al mostrador sin conexión</button> : null}
      {online ? <button className={styles.action} type="button" onClick={() => setLocal(false)}>Volver al mostrador con internet</button> : null}
    </div> : null}
    <div className={styles.mode} ref={onlineView} tabIndex={-1} hidden={!online || local} inert={!online || local}>
      {children}
      <p className={styles.offlineEntry}>¿Se cortó internet o vas a vender sin conexión?{' '}
        <button className={styles.secondaryAction} type="button" onClick={() => setLocal(true)}>Preparar o abrir mostrador sin conexión</button></p>
    </div>
    <div className={styles.mode} hidden={!local} inert={!local}>{offlinePos}</div>
  </>;
}
