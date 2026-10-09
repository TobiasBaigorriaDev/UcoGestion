import React from 'react';
import axe from 'axe-core';
import { OpaqueProgress } from '../../src/features/offline/opaque-progress';
import { createRoot } from 'react-dom/client';
import { OfflineSettings } from '../../src/features/offline/offline-settings';
import { OfflineSetup } from '../../src/offline/offline-setup';
import { OfflineDatabase } from '../../src/offline/offline-database';
import { retireOfflineIdentity, observeIdentityRetirement } from '../../src/offline/offline-identity';

const frame = document.getElementById('fixture') as HTMLIFrameElement;
const fixture = () => (frame.contentWindow as Window & { posHarness: { initialize(): Promise<void>; open(): Promise<unknown> } }).posHarness;
while (!fixture()) await new Promise(resolve => setTimeout(resolve, 10));
await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
await fixture().initialize(); await fixture().open();
const org = '11111111-1111-4111-8111-111111111111', device = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333', branch = '44444444-4444-4444-8444-444444444444';
const db = new OfflineDatabase(org, device);
const { publicKey } = await (await fetch('/test-delivery/key')).json();
const ack = await crypto.subtle.importKey('spki', Uint8Array.from(atob(publicKey), v => v.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const stored = await db.device_keys.get('device');
if (!stored) throw new Error('Missing device fixture');
await db.device_keys.put({ ...stored, ackKeys: { ...stored.ackKeys, 'test-ack': ack } });
const setup = new OfflineSetup(db, actor, branch, true, true);
observeIdentityRetirement();
Object.assign(window, { offlineSettingsHarness: {
  retire: async () => { await retireOfflineIdentity(db); window.dispatchEvent(new Event('uco:identity-retired')); },
  pending: () => db.deliveryBytes(),
  seedForeign: async () => {
    const id = '77777777-7777-4777-8777-777777777777';
    await db.putEncrypted('foreign-private-actor', 'operation', id, new Uint8Array([99]));
    await db.enqueueOpaque(id, new TextEncoder().encode(JSON.stringify({ version: 1, operationId: id, keyId: 'fixture', certificate: 'opaque-device', ciphertext: 'foreign-private-content' })));
    await db.delivery_receipts.put({ id: 'foreign-rejection', status: 'SECURITY_REJECTED', envelopeHash: 'a'.repeat(64) });
    window.dispatchEvent(new Event('uco:delivery-state'));
  },
}, axe });
document.documentElement.style.setProperty('--font-plus-jakarta', '"Plus Jakarta Sans", "Plus Jakarta Sans Fallback"');
document.body.style.padding = '24px';
const root = document.getElementById('root'); if (!root) throw new Error('Missing root');
createRoot(root).render(<><OfflineSettings role="OWNER" configured unlock={setup.unlock} authorize={setup.authorize}
  refresh={setup.refresh} sync={setup.sync} lock={setup.lock} readStatus={setup.readStatus} /><OpaqueProgress /></>);
