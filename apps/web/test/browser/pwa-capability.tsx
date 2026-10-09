import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OfflineProvider } from '../../app/offline-provider';
import { authorizePosOffline } from '../../src/offline/authorize-pos';
import { requireOfflineCapabilities } from '../../src/offline/capability-gate';

function CapabilityFixture() {
  const [status, setStatus] = useState('Disponible online');
  return <><OfflineProvider /><h1>Verificación PWA</h1>
    <button onClick={() => { void fetch('/api/v1/online-check').then(() => setStatus('Lectura online disponible')); }}>Consultar online</button>
    <button onClick={() => { void authorizePosOffline('tenant', { branchId: 'branch', publicKey: 'key' }, 'key').catch(() => setStatus('Offline no disponible')); }}>Autorizar offline</button>
    <p role="status">{status}</p></>;
}
Object.assign(window, { capabilityHarness: { check: requireOfflineCapabilities } });
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(<CapabilityFixture />);
