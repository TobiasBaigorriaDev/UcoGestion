export interface OfflineCapabilities {
  readonly serviceWorker: boolean;
  readonly indexedDb: boolean;
  readonly webCrypto: boolean;
}

export function assessOfflineCapabilities(capabilities: OfflineCapabilities): {
  readonly allowed: boolean;
  readonly missing: readonly (keyof OfflineCapabilities)[];
} {
  const missing = (Object.keys(capabilities) as (keyof OfflineCapabilities)[])
    .filter((key) => !capabilities[key]);
  return { allowed: missing.length === 0, missing };
}

export async function requireOfflineCapabilities(): Promise<void> {
  if (typeof window === 'undefined' || !window.isSecureContext ||
      !('serviceWorker' in navigator) || !('indexedDB' in window) ||
      !crypto?.subtle || !crypto.getRandomValues) {
    throw new Error('Este navegador no admite las capacidades necesarias para POS offline.');
  }
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  if (!registration.active) await navigator.serviceWorker.ready;
  if (!registration.active) throw new Error('El service worker todavía no está activo.');
  const request = indexedDB.open('uconext-capability-check', 1);
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => { request.result.close(); indexedDB.deleteDatabase('uconext-capability-check'); resolve(); };
    request.onerror = () => reject(new Error('IndexedDB no está disponible.'));
  });
  await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
