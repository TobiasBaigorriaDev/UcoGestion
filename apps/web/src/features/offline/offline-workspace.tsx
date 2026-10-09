'use client';
import { useEffect, useState } from 'react';
import { loadOfflineSetup, type OfflineSetup } from '../../offline/offline-setup';
import { OfflineSettings } from './offline-settings';

export function OfflineWorkspace({ organizationId, branchId, role }: {
  organizationId: string; branchId: string; role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
}) {
  const [setup, setSetup] = useState<OfflineSetup | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (role === 'EMPLOYEE') return;
    let live = true, controller: OfflineSetup | undefined;
    setFailed(false); setSetup(null);
    void loadOfflineSetup(organizationId, branchId, role).then(value => {
      controller = value; if (live) setSetup(value); else value.close();
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; controller?.close(); };
  }, [organizationId, branchId, role, attempt]);
  if (role === 'EMPLOYEE') return <p role="alert">Tu rol no permite operar el POS offline.</p>;
  if (failed) return <section><h1>POS sin conexión</h1><p role="alert">No pudimos validar este equipo. Conectate e iniciá sesión nuevamente. Si aún no está autorizado, pedile a OWNER o ADMIN que lo prepare.</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Reintentar validación online</button></section>;
  if (!setup) return <p role="status">Validando identidad y equipo online…</p>;
  return <OfflineSettings role={role} configured={setup.configured} deviceAuthorized={setup.deviceAuthorized} unlock={setup.unlock}
    authorize={setup.authorize} refresh={setup.refresh} sync={setup.sync} lock={setup.lock} readStatus={setup.readStatus} />;
}
