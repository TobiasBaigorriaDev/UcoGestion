import { argon2id } from 'hash-wasm';

import { assertOfflineIdentity } from './offline-revocation';
import { OfflineDatabase } from './offline-database';
import { observeRetirement } from './identity-retirement-events';

const PIN_BACKOFF_THRESHOLD = 5;
const PIN_LIMIT = 10;
const PIN_VERSION = 1;

async function derivePinKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const bytes = await argon2id({ password: pin, salt, iterations: 3, parallelism: 1,
    memorySize: 65_536, hashLength: 32, outputType: 'binary' });
  try {
    return await crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-KW', false, ['wrapKey', 'unwrapKey']);
  } finally { bytes.fill(0); }
}

export class OfflineKeys {
  private static readonly instances = new Set<WeakRef<OfflineKeys>>();
  private static readonly observedWindows = new WeakSet<Window>();
  private generation = 0;
  private unlocked: { userId: string; dek: CryptoKey } | undefined;

  constructor(private readonly db: OfflineDatabase, private readonly now: () => number = Date.now) {
    OfflineKeys.instances.add(new WeakRef(this));
    if (typeof window !== 'undefined' && !OfflineKeys.observedWindows.has(window)) {
      observeRetirement(() => OfflineKeys.lockAll());
      OfflineKeys.observedWindows.add(window);
    }
  }

  static lockAll(databaseName?: string): void {
    for (const reference of OfflineKeys.instances) {
      const keys = reference.deref();
      if (!keys) OfflineKeys.instances.delete(reference);
      else if (!databaseName || keys.db.name === databaseName) keys.lock();
    }
  }

  async create(userId: string, pin: string): Promise<string> {
    const generation = this.generation;
    await assertOfflineIdentity(this.db,userId,false);
    if (pin.length < 8) throw new Error('El PIN debe tener al menos 8 caracteres.');
    if (await this.db.key_envelopes.get(userId)) throw new Error('Esta identidad ya tiene claves offline.');
    let device = await this.db.device_keys.get('device');
    if (!device) {
      const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      device = { id: 'device', signingKey: signing.privateKey, publicKey: signing.publicKey, wrappingKey };
      await this.db.device_keys.add(device);
    }
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kek = await derivePinKey(pin, salt);
    const pinWrapped = await crypto.subtle.wrapKey('raw', dek, kek, 'AES-KW');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, device.wrappingKey, pinWrapped);
    const wrappedDek = new Uint8Array(iv.length + ciphertext.byteLength);
    wrappedDek.set(iv);
    wrappedDek.set(new Uint8Array(ciphertext), iv.length);
    await this.db.key_envelopes.add({ userId, wrappedDek, salt, version: PIN_VERSION });
    const localDek = await crypto.subtle.unwrapKey('raw', pinWrapped, kek, 'AES-KW',
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    if (generation !== this.generation) {
      await this.db.key_envelopes.delete(userId);
      throw new Error('Identidad offline bloqueada.');
    }
    this.unlocked = { userId, dek: localDek };
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', device.publicKey));
    const base64 = btoa(String.fromCharCode(...spki));
    return `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----\n`;
  }

  async unlock(userId: string, pin: string): Promise<void> {
    this.lock();
    const generation = this.generation;
    await assertOfflineIdentity(this.db,userId);
    const state = await this.db.pin_attempts.get(userId);
    if (state?.locked) throw new Error('PIN bloqueado. Reautenticación online requerida.');
    if (state && state.retryAfter > this.now()) throw new Error('Debés esperar antes de volver a intentar.');
    const envelope = await this.db.key_envelopes.get(userId);
    if (!envelope || envelope.version !== PIN_VERSION) throw new Error('Credencial offline no disponible.');
    const device = await this.db.device_keys.get('device');
    if (!device) throw new Error('Dispositivo no autorizado.');
    try {
      const kek = await derivePinKey(pin, envelope.salt);
      const pinWrapped = await crypto.subtle.decrypt({ name: 'AES-GCM',
        iv: envelope.wrappedDek.slice(0, 12) }, device.wrappingKey, envelope.wrappedDek.slice(12));
      const dek = await crypto.subtle.unwrapKey('raw', pinWrapped, kek, 'AES-KW',
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await this.db.pin_attempts.delete(userId);
      await assertOfflineIdentity(this.db,userId);
      if (generation !== this.generation || !await this.db.key_envelopes.get(userId)) {
        throw new Error('Identidad offline bloqueada.');
      }
      this.unlocked = { userId, dek };
    } catch {
      const failures = (state?.failures ?? 0) + 1;
      await this.db.pin_attempts.put({ userId, failures, locked: failures >= PIN_LIMIT,
        retryAfter: failures >= PIN_BACKOFF_THRESHOLD
          ? this.now() + Math.min(60_000, 2 ** (failures - PIN_BACKOFF_THRESHOLD) * 1000)
          : 0 });
      throw new Error(failures >= PIN_LIMIT ? 'PIN bloqueado. Reautenticación online requerida.' : 'PIN incorrecto.');
    }
  }

  canCreate(): boolean { return this.unlocked !== undefined; }

  dekFor(userId: string): CryptoKey {
    if (!this.unlocked || this.unlocked.userId !== userId) throw new Error('Identidad offline bloqueada.');
    return this.unlocked.dek;
  }

  lock(): void { this.generation++; this.unlocked = undefined; }

  lockDevice(): void { OfflineKeys.lockAll(this.db.name); }

}
