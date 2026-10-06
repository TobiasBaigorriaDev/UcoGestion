/* UcoNext public shell only. Private data remains in encrypted IndexedDB. */
const CACHE_NAME = 'uconext-shell-v1';
const SHELL = ['/offline-shell-v1.html', '/offline-icon-v1.svg'];

// Fail closed before installation. The active worker and its cache stay usable.
async function verifyOfflineCompatibility() {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    throw new Error('OFFLINE_UPDATE_INCOMPATIBLE');
  }
  const databases = await indexedDB.databases();
  for (const entry of databases) {
    if (!entry.name?.startsWith('uconext-offline-')) continue;
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(entry.name);
      request.onupgradeneeded = () => { request.transaction.abort(); };
      request.onerror = () => reject(new Error('OFFLINE_UPDATE_INCOMPATIBLE'));
      request.onblocked = () => reject(new Error('OFFLINE_UPDATE_INCOMPATIBLE'));
      request.onsuccess = () => {
        const db = request.result;
        if (db.version !== 30 || !db.objectStoreNames.contains('delivery_queue')) {
          db.close();
          reject(new Error('OFFLINE_UPDATE_INCOMPATIBLE'));
          return;
        }
        const transaction = db.transaction('delivery_queue', 'readonly');
        const cursor = transaction.objectStore('delivery_queue').openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          try {
            const envelope = JSON.parse(new TextDecoder().decode(cursor.result.value.envelope));
            if (envelope.version !== 1 || typeof envelope.keyId !== 'string' || !envelope.keyId) {
              throw new Error('OFFLINE_UPDATE_INCOMPATIBLE');
            }
            cursor.result.continue();
          } catch { transaction.abort(); }
        };
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = transaction.onerror = () => {
          db.close(); reject(new Error('OFFLINE_UPDATE_INCOMPATIBLE'));
        };
      };
    });
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(verifyOfflineCompatibility().then(() =>
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(
    names.filter((name) => name.startsWith('uconext-shell-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)),
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match('/offline-shell-v1.html')) ?? Response.error();
    }));
  }
});
