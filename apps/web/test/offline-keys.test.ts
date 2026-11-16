import 'fake-indexeddb/auto';

import { webcrypto } from 'node:crypto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { OfflineDatabase } from '../src/offline/offline-database.js';
import { OfflineKeys } from '../src/offline/offline-keys.js';
import { OpaqueDelivery } from '../src/offline/opaque-delivery.js';
import { OfflineRecordCipher } from '../src/offline/offline-record-cipher.js';

const org = '11111111-1111-4111-8111-111111111111';
const device = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';
const anotherUser = '44444444-4444-4444-8444-444444444444';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

describe('T189 offline keys', () => {
  afterEach(async () => { await Dexie.delete(OfflineDatabase.nameFor(org, device)); });

  it('changes only the PIN wrapping, preserving ciphertext, pending envelopes and another identity after reload', async () => {
    const db = new OfflineDatabase(org, device); await db.open();
    const keys = new OfflineKeys(db);
    await keys.create(anotherUser, 'other-identity-pin');
    const other = await db.key_envelopes.get(anotherUser);
    await keys.create(user, 'original-pin');
    const before = await db.key_envelopes.get(user);
    const context = { organizationId: org, deviceId: device, userId: user, kind: 'sale', id: 'pending' };
    const cipher = new OfflineRecordCipher(), plaintext = new TextEncoder().encode('private pending sale');
    const ciphertext = await cipher.encrypt(keys.dekFor(user), context, plaintext);
    await db.putEncrypted(user, 'sale', 'pending', ciphertext);
    await db.enqueueOpaque('pending', new Uint8Array([7, 8, 9]));
    const pending = await db.deliveryBytes(), storedDevice = await db.device_keys.get('device');
    await keys.changePin(user, 'original-pin', 'replacement-pin');
    const after = await db.key_envelopes.get(user);
    expect(after?.salt).not.toEqual(before?.salt);
    expect(after?.wrappedDek).not.toEqual(before?.wrappedDek);
    expect(await db.key_envelopes.get(anotherUser)).toEqual(other);
    expect(Array.from((await db.getEncrypted(user, 'sale', 'pending')) ?? [])).toEqual(Array.from(ciphertext));
    expect(await db.deliveryBytes()).toEqual(pending);
    expect(await db.device_keys.get('device')).toEqual(storedDevice);
    keys.lock(); db.close(); await db.open();
    const reloaded = new OfflineKeys(db);
    await expect(reloaded.unlock(user, 'original-pin')).rejects.toThrow('PIN incorrecto');
    await reloaded.unlock(user, 'replacement-pin');
    expect(reloaded.dekFor(user).extractable).toBe(false);
    expect(Array.from(await cipher.decrypt(reloaded.dekFor(user), context, ciphertext))).toEqual(Array.from(plaintext));
    reloaded.lock(); db.close();
  });

  it('rejects incorrect, blocked and invalid PIN changes without replacing credentials or pending bytes', async () => {
    const db = new OfflineDatabase(org, device); await db.open();
    const keys = new OfflineKeys(db); await keys.create(user, 'original-pin');
    await db.enqueueOpaque('pending', new Uint8Array([1, 2]));
    const before = await db.key_envelopes.get(user), pending = await db.deliveryBytes();
    await expect(keys.changePin(user, 'wrong-pin', 'replacement-pin')).rejects.toThrow('PIN incorrecto');
    expect((await db.pin_attempts.get(user))?.failures).toBe(1);
    await expect(keys.changePin(user, 'original-pin', 'short')).rejects.toThrow();
    await expect(keys.changePin(user, 'original-pin', 'original-pin')).rejects.toThrow();
    await db.pin_attempts.put({ userId: user, failures: 10, locked: true, retryAfter: 0 });
    await expect(keys.changePin(user, 'original-pin', 'replacement-pin')).rejects.toThrow(/bloqueado/);
    expect(await db.key_envelopes.get(user)).toEqual(before);
    expect(await db.deliveryBytes()).toEqual(pending);
    db.close();
  });

  it('rolls back a failed wrapping write and blocks retirement or known revocation without losing pending bytes', async () => {
    const db = new OfflineDatabase(org, device); await db.open();
    const keys = new OfflineKeys(db); await keys.create(user, 'original-pin');
    await db.enqueueOpaque('pending', new Uint8Array([1, 2]));
    const before = await db.key_envelopes.get(user), pending = await db.deliveryBytes();
    const fail = () => { throw new Error('Storage failure'); };
    db.key_envelopes.hook('updating', fail);
    await expect(keys.changePin(user, 'original-pin', 'replacement-pin')).rejects.toThrow('Storage failure');
    db.key_envelopes.hook('updating').unsubscribe(fail);
    expect(await db.key_envelopes.get(user)).toEqual(before);
    expect(keys.canCreate()).toBe(false);
    await keys.unlock(user, 'original-pin');
    const changing = keys.changePin(user, 'original-pin', 'replacement-pin'); keys.lock();
    await expect(changing).rejects.toThrow(/bloqueada/);
    const stored = await db.device_keys.get('device'); if (!stored) throw new Error('Missing keys');
    await db.device_keys.put({ ...stored, revokedUsers: [user] });
    await expect(keys.changePin(user, 'original-pin', 'replacement-pin')).rejects.toThrow('OFFLINE_REVOKED');
    expect(await db.key_envelopes.get(user)).toEqual(before);
    expect(await db.deliveryBytes()).toEqual(pending);
    db.close();
  });

  it('commits only one of two concurrent PIN replacements and preserves decryption with the winning PIN', async () => {
    const db = new OfflineDatabase(org, device); await db.open();
    const first = new OfflineKeys(db), second = new OfflineKeys(db);
    await first.create(user, 'original-pin');
    const results = await Promise.allSettled([first.changePin(user, 'original-pin', 'first-new-pin'), second.changePin(user, 'original-pin', 'second-new-pin')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winningPin = results[0]?.status === 'fulfilled' ? 'first-new-pin' : 'second-new-pin';
    const fresh = new OfflineKeys(db); await fresh.unlock(user, winningPin);
    expect(fresh.dekFor(user).extractable).toBe(false);
    await expect(fresh.unlock(user, 'original-pin')).rejects.toThrow('PIN incorrecto');
    db.close();
  });

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
