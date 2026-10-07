/* Device transport only: this worker never opens identity records or PIN stores. */
const deliveryEncoder = new TextEncoder();
const deliveryBase64 = value => btoa(String.fromCharCode(...value));
const deliveryDecode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
const deliveryHash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), byte => byte.toString(16).padStart(2, '0')).join('');
function deliveryRequest(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function openDeliveryDatabase(name) {
  const request = indexedDB.open(name);
  request.onupgradeneeded = () => request.transaction.abort();
  return deliveryRequest(request);
}
async function readDeliveryStore(db, name) {
  return deliveryRequest(db.transaction(name, 'readonly').objectStore(name).getAll());
}
async function rememberDeliveryAck(db, row, ack) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('delivery_queue', 'readwrite');
    const store = transaction.objectStore('delivery_queue');
    const read = store.get(row.id);
    read.onsuccess = () => {
      const current = read.result;
      if (current && current.envelope.length === row.envelope.length && current.envelope.every((value, index) => value === row.envelope[index])) store.put({ ...current, ack });
      else transaction.abort();
    };
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('OFFLINE_ACK_INVALID'));
  });
}
async function deliverWorkerDatabase(db) {
  const device = (await readDeliveryStore(db, 'device_keys')).find(row => row.id === 'device');
  if (!device) return;
  const rows = (await readDeliveryStore(db, 'delivery_queue')).filter(row => !row.ack);
  const groups = new Map();
  for (const row of rows) {
    const routing = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(row.envelope));
    if (typeof routing.certificate !== 'string') throw new Error('OFFLINE_ENVELOPE_INVALID');
    groups.set(routing.certificate, [...(groups.get(routing.certificate) ?? []), row]);
  }
  for (const [certificate, group] of groups) {
    for (let offset = 0; offset < group.length; offset += 50) {
      const batch = group.slice(offset, offset + 50), envelopes = batch.map(row => new TextDecoder('utf-8', { fatal: true }).decode(row.envelope));
      const post = async (path, body) => {
        const response = await fetch(`/api/v1/offline/delivery/${path}`, { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error('OFFLINE_DELIVERY_UNAVAILABLE');
        return response.json();
      };
      const { challenge } = await post('challenge', { certificate });
      if (typeof challenge !== 'string') throw new Error('OFFLINE_DELIVERY_UNAVAILABLE');
      const checkpoints = device.knowledge;
      const payload = JSON.stringify({ domain: 'UcoNext:delivery:v1', challenge, batchHash: await deliveryHash(deliveryEncoder.encode(JSON.stringify(envelopes))),
        ...(checkpoints ? { checkpointHash: await deliveryHash(deliveryEncoder.encode(JSON.stringify(checkpoints))) } : {}) });
      const proof = deliveryBase64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.signingKey, deliveryEncoder.encode(payload))));
      const response = await post('push', { certificate, challenge, envelopes, proof, ...(checkpoints ? { checkpoints } : {}) });
      if (!Array.isArray(response.acks)) throw new Error('OFFLINE_ACK_INVALID');
      for (const ack of response.acks) {
        if (typeof ack !== 'string' || ack.length > 2048) throw new Error('OFFLINE_ACK_INVALID');
        const [header, body, signature, ...extra] = ack.split('.');
        if (!header || !body || !signature || extra.length) throw new Error('OFFLINE_ACK_INVALID');
        const metadata = JSON.parse(new TextDecoder().decode(deliveryDecode(header)));
        const claims = JSON.parse(new TextDecoder().decode(deliveryDecode(body)));
        const key = device.ackKeys?.[metadata.kid], row = batch.find(value => value.id === claims.operationId);
        if (!row || !key || metadata.alg !== 'ES256' || metadata.typ !== 'uco-offline-ack+jwt' ||
          Object.keys(metadata).sort().join(',') !== 'alg,kid,typ' || Object.keys(claims).sort().join(',') !== 'envelopeHash,keyId,operationId,status,version' ||
          claims.version !== 1 || claims.keyId !== metadata.kid || !['ACKED', 'SECURITY_REJECTED'].includes(claims.status) ||
          await deliveryHash(row.envelope) !== claims.envelopeHash || !await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, deliveryDecode(signature), deliveryEncoder.encode(`${header}.${body}`))) throw new Error('OFFLINE_ACK_INVALID');
        // Leave the sealed bytes intact. Foreground performs the atomic identity
        // payload/transport cleanup after independently verifying this ACK.
        await rememberDeliveryAck(db, row, ack);
      }
    }
  }
}
let workerDelivery;
function deliverWorkerQueues() {
  if (workerDelivery) return workerDelivery;
  workerDelivery = (async () => {
    const databases = await indexedDB.databases();
    for (const entry of databases) {
      if (!entry.name?.startsWith('uconext-offline-')) continue;
      const db = await openDeliveryDatabase(entry.name);
      try { await deliverWorkerDatabase(db); } finally { db.close(); }
    }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'uco:delivery-request' });
  })().finally(() => { workerDelivery = undefined; });
  return workerDelivery;
}
