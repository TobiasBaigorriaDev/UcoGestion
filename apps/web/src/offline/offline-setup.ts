import { offlineBootstrapPayloadSchema, offlineGrantProofPayload, offlineGrantProofSchema, signedOfflineDocumentSchema } from '@uconext/shared';
import { z } from 'zod';
import { ApiClient } from '../lib/api/client';
import { CashCommandRetry, findLocalCashDevice, loadCashWorkspace } from '../features/cash/cash-api';
import { authorizePosOffline } from './authorize-pos';
import { OfflineAuthorization } from './offline-authorization';
import { base64, bytes, unbase64 } from './offline-crypto';
import { OfflineDatabase } from './offline-database';
import { activateOfflineIdentity } from './offline-identity';
import { OfflineKeys } from './offline-keys';
import { OfflineLease } from './offline-lease';
import { OfflineRecordCipher } from './offline-record-cipher';
import { OpaqueDelivery } from './opaque-delivery';
import { readOfflineStatus } from './offline-status';

const api = new ApiClient();
const encoder = new TextEncoder();
const hex = (value: Uint8Array) => Array.from(value, v => v.toString(16).padStart(2, '0')).join('');

export class OfflineSetup {
  private keys: OfflineKeys;
  constructor(private db: OfflineDatabase, readonly userId: string, readonly branchId: string,
    readonly configured: boolean, private registered: boolean) { this.keys = new OfflineKeys(db); }
  get deviceAuthorized() { return this.registered; }
  readonly lock = () => this.keys.lock();
  close() { this.lock(); this.db.close(); }
  private async authorization() {
    const record = await this.db.getEncrypted(this.userId, 'authorization', 'current');
    if (!record) throw new Error('Prepará este equipo online.');
    const stored = z.object({ bootstrap: signedOfflineDocumentSchema }).parse(JSON.parse(new TextDecoder().decode(
      await new OfflineRecordCipher().decrypt(this.keys.dekFor(this.userId), { organizationId: this.db.organizationId,
        deviceId: this.db.deviceId, userId: this.userId, kind: 'authorization', id: 'current' }, record))));
    const device = await this.db.device_keys.get('device'), key = device?.ackKeys?.[stored.bootstrap.signingKeyId];
    if (!key) throw new Error('Firma offline no disponible.');
    return new OfflineAuthorization(this.db, this.keys, key, stored.bootstrap.signingKeyId);
  }
  private async status() { return readOfflineStatus(this.db, this.keys, await this.authorization(), this.userId); }
  readonly readStatus = () => this.status();
  readonly unlock = async (pin: string) => { await this.keys.unlock(this.userId, pin); return this.status(); };
  readonly sync = async () => { await new OpaqueDelivery(this.db).flush(); return this.status(); };
  readonly authorize = async (pin: string) => {
    if (await this.db.key_envelopes.get(this.userId)) await this.keys.unlock(this.userId, pin);
    else await this.keys.create(this.userId, pin);
    if (!this.registered) {
      let stored = await this.db.device_keys.get('device');
      if (!stored || (stored.registrationActor && stored.registrationActor !== this.userId)) throw new Error('La autorización pendiente pertenece a otra identidad.');
      if (!stored.registrationKey) {
        stored = { ...stored, registrationKey: crypto.randomUUID(), registrationActor: this.userId };
        await this.db.device_keys.put(stored);
      }
      const publicKey = `-----BEGIN PUBLIC KEY-----\n${base64(new Uint8Array(await crypto.subtle.exportKey('spki', stored.publicKey)))}\n-----END PUBLIC KEY-----\n`;
      const authorized = await authorizePosOffline(this.db.organizationId, { branchId: this.branchId, publicKey }, stored.registrationKey ?? '');
      if (!authorized) throw new Error('Autorización no disponible.');
      const next = new OfflineDatabase(this.db.organizationId, authorized.id), envelope = await this.db.key_envelopes.get(this.userId);
      if (!envelope || await this.db.delivery_queue.count()) throw new Error('Preparación pendiente.');
      await next.transaction('rw', [next.device_keys, next.key_envelopes], async () => {
        await next.device_keys.put({ ...stored, certificate: authorized.certificate }); await next.key_envelopes.put(envelope);
      });
      await this.db.delete(); this.lock(); this.db = next; this.keys = new OfflineKeys(next);
      this.registered = true;
      await this.keys.unlock(this.userId, pin);
    }
    return this.refresh();
  };
  readonly refresh = async () => {
    // A new grant is issued only after all opaque operations have definitive ACKs.
    await new OpaqueDelivery(this.db).flush();
    const leases = new OfflineLease(this.db), lease = await leases.acquire(crypto.randomUUID(), 60_000);
    try {
      const device = await this.db.device_keys.get('device');
      if (!device) throw new Error('Dispositivo no disponible.');
      this.keys.dekFor(this.userId);
      const retries = new CashCommandRetry(`offline:${this.db.organizationId}:${this.db.deviceId}:${this.userId}`);
      const bootstrapInput = { deviceId: this.db.deviceId, branchId: this.branchId };
      const bootstrap = await this.command('/offline/bootstrap', bootstrapInput, await retries.key('bootstrap', bootstrapInput), signedOfflineDocumentSchema.parse);
      const payload = offlineBootstrapPayloadSchema.parse(JSON.parse(bootstrap.payload));
      if (payload.actorUserId !== this.userId || payload.organizationId !== this.db.organizationId || payload.deviceId !== this.db.deviceId) throw new Error('OFFLINE_IDENTITY_MISMATCH');
      const proofInput = { grantId: payload.grantId, bootstrapHash: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(bootstrap.payload)))),
        deviceSequence: lease.sequence, headHash: lease.headHash ? hex(unbase64(lease.headHash)) : null };
      const proof = base64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.signingKey, encoder.encode(offlineGrantProofPayload(proofInput)))));
      const request = { ...proofInput, proof };
      // ECDSA proof bytes vary on retry; the business proof payload is stable.
      const key = await retries.key('grant', proofInput);
      const pendingId = `grant:${payload.grantId}`;
      const cipher = new OfflineRecordCipher(), context = { organizationId: this.db.organizationId, deviceId: this.db.deviceId, userId: this.userId, kind: 'grant-request', id: pendingId };
      const prior = await this.db.getEncrypted(this.userId, 'grant-request', pendingId);
      const stable = offlineGrantProofSchema.parse(prior ? JSON.parse(new TextDecoder().decode(await cipher.decrypt(this.keys.dekFor(this.userId), context, prior))) : request);
      if (!prior) await this.db.putEncrypted(this.userId, 'grant-request', pendingId, await cipher.encrypt(this.keys.dekFor(this.userId), context, encoder.encode(JSON.stringify(request))));
      const result = await this.command('/offline/authorize', stable, key, value => z.object({ grant: z.string() }).parse(value));
      // Initial trust is acquired over the authenticated same-origin HTTPS bootstrap response.
      const trusted = await crypto.subtle.importKey('spki', bytes(unbase64(payload.ackKey.publicKeyPem.replace(/-----[^-]+-----|\s/g, ''))), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      await leases.assert(lease);
      await new OfflineAuthorization(this.db, this.keys, trusted, payload.ackKey.keyId).install(this.userId, bootstrap, result.grant);
      retries.complete('bootstrap'); retries.complete('grant');
      await this.db.records.delete([this.userId, 'grant-request', pendingId]);
      return this.status();
    } finally { await leases.release(lease); }
  };
  private async command<T>(path: string, body: unknown, key: string, parse: (value: unknown) => T): Promise<T> {
    const csrf = await api.request('/auth/csrf', { method: 'GET', parse: value => z.object({ csrfToken: z.string() }).parse(value) });
    if (!csrf) throw new Error('CSRF unavailable');
    const result = await api.request(path, { method: 'POST', organizationId: this.db.organizationId, body, csrfToken: csrf.csrfToken, idempotencyKey: key, parse });
    if (!result) throw new Error('Offline response unavailable'); return result;
  }
}

export async function loadOfflineSetup(organizationId: string, branchId: string, role: string): Promise<OfflineSetup> {
  const workspace = await loadCashWorkspace(organizationId, branchId);
  const deviceId = await findLocalCashDevice(organizationId, workspace.devices);
  if (!deviceId && !['OWNER', 'ADMIN'].includes(role)) throw new Error('Pedile a OWNER o ADMIN que autorice este equipo.');
  // A branch UUID names the temporary registration database; no business operations use it.
  const db = new OfflineDatabase(organizationId, deviceId ?? branchId);
  if (deviceId) {
    const reauthenticated = sessionStorage.getItem('uco:password-reauthenticated') === 'true';
    await activateOfflineIdentity(db, workspace.actorUserId, reauthenticated);
    if (reauthenticated) sessionStorage.removeItem('uco:password-reauthenticated');
  }
  const configured = Boolean(await db.getEncrypted(workspace.actorUserId, 'authorization', 'current'));
  return new OfflineSetup(db, workspace.actorUserId, branchId, configured, Boolean(deviceId));
}
