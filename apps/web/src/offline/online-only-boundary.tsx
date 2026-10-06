'use client';

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { isBusinessOnline } from '../lib/api/online-only';
import styles from './online-only-boundary.module.css';

function subscribe(listener: () => void) {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener); };
}

/** Wrap the online workspace so cached forms/reports are not operable offline.
 * The local POS surface will mount outside this boundary when integrated. */
export function OnlineOnlyBoundary({ children }: { children: ReactNode }) {
  const online = useSyncExternalStore(subscribe, isBusinessOnline, () => true);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!online) notice.current?.focus(); }, [online]);
  if (online) return children;
  return <main id="contenido-principal" className={styles.page}>
    <div ref={notice} tabIndex={-1} role="alert" className={styles.notice}>
      <h1>Esta pantalla necesita conexión</h1>
      <p>Volvé a conectarte para continuar con la administración.</p>
      <p>Las operaciones pendientes del POS se conservan en este dispositivo.</p>
    </div>
  </main>;
}
