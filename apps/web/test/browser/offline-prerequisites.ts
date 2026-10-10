import { offlineBootstrapPayloadSchema, signedOfflineDocumentSchema, offlineGrantProofPayload } from '@uconext/shared';
import { OfflineDatabase } from '../../src/offline/offline-database';
import { OfflineKeys } from '../../src/offline/offline-keys';
import { OfflineAuthorization } from '../../src/offline/offline-authorization';
import { OfflineSealer, type SealTransport } from '../../src/offline/offline-sealer';
import { OfflineLease } from '../../src/offline/offline-lease';
import { OfflinePos } from '../../src/offline/offline-pos';
import { requireOfflineCapabilities } from '../../src/offline/capability-gate';

const params = new URL(location.href).searchParams;
const organizationId = params.get('organizationId'), userId = params.get('userId'), branchId = params.get('branchId');
if (!organizationId || !userId || !branchId) throw new Error('Missing prerequisites context');
await requireOfflineCapabilities();
let db = new OfflineDatabase(organizationId, crypto.randomUUID());
let keys = new OfflineKeys(db);
await keys.create(userId, '12345678');
const initial = await db.device_keys.get('device');
if (!initial) throw new Error('Missing device keys');
let trusted = initial.publicKey;
// Missing transport credentials are deliberate; no business operation may reach sealing yet.
let transport: SealTransport = { certificate: '', publication: { payload: '', signature: '', signingKeyId: 'trusted' }, trustedSigner: trusted, trustedSigningKeyId: 'trusted' };
let bootstrap: ReturnType<typeof signedOfflineDocumentSchema.parse> | undefined;
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const command = async (path: string, body: unknown) => {
  const csrfResponse = await fetch('/api/v1/auth/csrf');
  const csrf = await csrfResponse.json();
  const response = await fetch(`/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Organization-Id': organizationId, 'X-CSRF-Token': csrf.csrfToken ?? '', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
Object.assign(window, { prerequisites: {
  async open() {
    const before = { records: await db.records.count(), envelopes: await db.delivery_queue.count() };
    try {
      const authorization = new OfflineAuthorization(db, keys, trusted, 'trusted');
      const result = await new OfflinePos(db, keys, authorization, new OfflineSealer(db, keys, new OfflineLease(db), transport))
        .open(userId, { cashRegisterId: bootstrap ? offlineBootstrapPayloadSchema.parse(JSON.parse(bootstrap.payload)).configuration.cashRegisters[0]?.id ?? crypto.randomUUID() : crypto.randomUUID(), openingCash: '0.00' });
      return { result, before, after: { records: await db.records.count(), envelopes: await db.delivery_queue.count() } };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error), before,
      after: { records: await db.records.count(), envelopes: await db.delivery_queue.count() } }; }
  },
  async unauthorizedBootstrap() { return command('/offline/bootstrap', { branchId, deviceId: db.deviceId }); },
  async register() {
    const publicKey = `-----BEGIN PUBLIC KEY-----\n${encode(new Uint8Array(await crypto.subtle.exportKey('spki', initial.publicKey)))}\n-----END PUBLIC KEY-----\n`;
    const result = await command('/devices/authorize-pos', { branchId, publicKey });
    if (result.status !== 201) return result;
    const next = new OfflineDatabase(organizationId, result.body.id as string), envelope = await db.key_envelopes.get(userId);
    if (!envelope) throw new Error('Missing key envelope');
    await next.device_keys.put({ ...initial, certificate: result.body.certificate as string });
    await next.key_envelopes.put(envelope); keys.lock(); db.close(); db = next; keys = new OfflineKeys(db); await keys.unlock(userId, '12345678');
    return result;
  },
  async bootstrap() {
    const result = await command('/offline/bootstrap', { branchId, deviceId: db.deviceId });
    if (result.status === 201) bootstrap = signedOfflineDocumentSchema.parse(result.body);
    return result;
  },
  async grant(incomplete: boolean) {
    if (!bootstrap) throw new Error('Missing bootstrap');
    const payload = offlineBootstrapPayloadSchema.parse(JSON.parse(bootstrap.payload));
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bootstrap.payload))), byte => byte.toString(16).padStart(2, '0')).join('');
    const input = { grantId: payload.grantId, bootstrapHash: hash, deviceSequence: incomplete ? '1' : '0', headHash: incomplete ? 'a'.repeat(64) : null };
    const proof = encode(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, initial.signingKey, new TextEncoder().encode(offlineGrantProofPayload(input)))));
    const result = await command('/offline/authorize', { ...input, proof });
    if (result.status === 201) {
      trusted = await crypto.subtle.importKey('spki', Uint8Array.from(atob(payload.ackKey.publicKeyPem.replace(/-----[^-]+-----|\s/g, '')), char => char.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      transport = { certificate: (await db.device_keys.get('device'))?.certificate ?? '', publication: payload.ingestionKey, trustedSigner: trusted, trustedSigningKeyId: 'trusted' };
      await new OfflineAuthorization(db, keys, trusted, 'trusted').install(userId, bootstrap, result.body.grant as string);
    }
    return result;
  },
} });
