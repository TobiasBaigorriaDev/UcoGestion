import 'fake-indexeddb/auto';

import { webcrypto } from 'node:crypto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { OfflineDatabase } from '../src/offline/offline-database.js';
import { OfflineKeys } from '../src/offline/offline-keys.js';
import { OpaqueDelivery } from '../src/offline/opaque-delivery.js';

const org = '11111111-1111-4111-8111-111111111111';
const device = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';
const anotherUser = '44444444-4444-4444-8444-444444444444';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

describe('T189 offline keys', () => {
  afterEach(async () => { await Dexie.delete(OfflineDatabase.nameFor(org, device)); });

  it('creates a non-exportable device signer and PIN-wrapped DEK, then locks reading while retaining opaque delivery', async () => {
    const db = new OfflineDatabase(org, device);
    await db.open();
    const keys = new OfflineKeys(db);
    const publicKey = await keys.create(user, 'long-pin-123');
    expect(publicKey).toContain('BEGIN PUBLIC KEY');
    const stored = await db.device_keys.get('device');
    if (!stored) throw new Error('Device keys missing.');
    expect(stored?.signingKey.extractable).toBe(false);
    expect(stored?.wrappingKey.extractable).toBe(false);
    await db.enqueueOpaque('pending', new Uint8Array([1, 2]));
    keys.lock();
    expect(keys.canCreate()).toBe(false);
    expect((await db.deliveryBytes()).length).toBe(1);
    const delivery = new OpaqueDelivery(db);
    const challenge = new Uint8Array([7, 8]);
    const signature = await delivery.signChallenge(challenge);
    expect(signature.length).toBeGreaterThan(0);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, stored.publicKey,
      signature as BufferSource, challenge as BufferSource)).toBe(false);
    expect((await delivery.pendingBytes()).length).toBe(1);
    await keys.unlock(user, 'long-pin-123');
    expect(keys.canCreate()).toBe(true);
    keys.lock();
    expect(await keys.create(anotherUser, 'another-pin-123')).toBe(publicKey);
    expect(() => keys.dekFor(user)).toThrow(/bloqueada/);
    keys.lock();
    db.close();
  });

  it('persists failed PIN backoff and locks after the configured limit without deleting ciphertext', async () => {
    const db = new OfflineDatabase(org, device);
    await db.open();
    let now = 1_000_000;
    const keys = new OfflineKeys(db, () => now);
    await keys.create(user, 'correct-pin');
    keys.lock();
    await expect(keys.unlock(user, 'wrong-pin')).rejects.toThrow();
    expect((await db.pin_attempts.get(user))?.failures).toBe(1);
    // Before the fifth failure, retries are allowed; backoff begins at five.
    for (let attempt = 2; attempt <= 5; attempt++) {
      now += 60_000;
      await expect(keys.unlock(user, 'wrong-pin')).rejects.toThrow();
    }
    expect((await db.pin_attempts.get(user))?.locked).toBe(false);
    await expect(keys.unlock(user, 'correct-pin')).rejects.toThrow(/esperar/i);
    db.close(); await db.open();
    for (let attempt = 6; attempt <= 10; attempt++) {
      now += 60_000;
      await expect(keys.unlock(user, 'wrong-pin')).rejects.toThrow();
    }
    now += 60_000;
    await expect(keys.unlock(user, 'correct-pin')).rejects.toThrow(/bloqueado/i);
    expect((await db.pin_attempts.get(user))?.locked).toBe(true);
    expect(await db.key_envelopes.get(user)).toBeDefined();
    db.close();
  }, 20_000);
});
