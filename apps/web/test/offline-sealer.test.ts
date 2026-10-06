import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import Dexie from 'dexie';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OfflineDatabase } from '../src/offline/offline-database.js';
import { OfflineKeys } from '../src/offline/offline-keys.js';
import { OfflineLease } from '../src/offline/offline-lease.js';
import { OfflineSealer } from '../src/offline/offline-sealer.js';
import { OfflineRecordCipher } from '../src/offline/offline-record-cipher.js';
import { base64, bytes, hash, encode, unbase64 } from '../src/offline/offline-crypto.js';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const org = '11111111-1111-4111-8111-111111111111';
const device = '22222222-2222-4222-8222-222222222222';
const alice = '33333333-3333-4333-8333-333333333333';
const bob = '44444444-4444-4444-8444-444444444444';
describe('T191 atomic offline sealing', () => {
  let trusted: CryptoKeyPair;
  let publication: { payload: string; signature: string; signingKeyId: string };
  beforeAll(async () => {
    trusted = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const rsa = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['wrapKey', 'unwrapKey']);
    const payload = JSON.stringify({ version: 1, keyId: 'key', algorithm: 'RSA-OAEP-3072/SHA-256', publicKey: `-----BEGIN PUBLIC KEY-----\n${base64(new Uint8Array(await crypto.subtle.exportKey('spki', rsa.publicKey)))}\n-----END PUBLIC KEY-----` });
    publication = { payload, signature: base64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, trusted.privateKey, bytes(new TextEncoder().encode(payload))))), signingKeyId: 'trusted' };
  });
  afterEach(async () => { await Dexie.delete(OfflineDatabase.nameFor(org, device)); });

  async function setup(now: () => number = Date.now) {
    const db = new OfflineDatabase(org, device);
    const keys = new OfflineKeys(db);
    await keys.create(alice, 'long-pin-alice');
    return { db, keys, sealer: new OfflineSealer(db, keys, new OfflineLease(db, now),
      { certificate: 'opaque', publication, trustedSigner: trusted.publicKey, trustedSigningKeyId: 'trusted' }) };
  }
  const input = { userId: alice, sessionId: 'cash-session', kind: 'sale', payload: { total: '10.00' },
    grant: { version: 1 }, configVersion: '1', occurredAt: '2026-10-06T12:00:00.000Z' };

  it('persists signed chain, identity ciphertext and immutable opaque envelope together, surviving reopen and identity switch', async () => {
    const { db, keys, sealer } = await setup();
    const first = await sealer.seal(input);
    const cipher = new OfflineRecordCipher();
    const raw = await db.getEncrypted(alice, 'operation', first.id);
    if (!raw) throw new Error('Missing record.');
    const signed = JSON.parse(new TextDecoder().decode(await cipher.decrypt(keys.dekFor(alice),
      { organizationId: org, deviceId: device, userId: alice, kind: 'operation', id: first.id }, raw)));
    expect(signed.operation).toMatchObject({ sequence: '1', sessionSequence: '1', actorId: alice, previousHash: null });
    const deviceKeys = await db.device_keys.get('device');
    if (!deviceKeys) throw new Error('Missing device key.');
    expect(signed.hash).toBe(await hash(encode(signed.operation)));
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, deviceKeys.publicKey,
      bytes(unbase64(signed.signature)), bytes(unbase64(signed.hash)))).toBe(true);
    const second = await sealer.seal(input);
    expect(second.sequence).toBe('2');
    const secondRaw = await db.getEncrypted(alice, 'operation', second.id);
    if (!secondRaw) throw new Error('Missing second record.');
    const secondSigned = JSON.parse(new TextDecoder().decode(await cipher.decrypt(keys.dekFor(alice),
      { organizationId: org, deviceId: device, userId: alice, kind: 'operation', id: second.id }, secondRaw)));
    expect(secondSigned.operation).toMatchObject({ sequence: '2', sessionSequence: '2', previousHash: first.hash });
    expect((await db.meta.get('device-chain'))?.headHash).toBe(second.hash);
    const original = (await db.deliveryBytes()).find(row => row.id === first.id)?.envelope;
    keys.lock();
    await expect(sealer.seal(input)).rejects.toThrow();
    await keys.create(bob, 'long-pin-bob');
    expect(await db.getEncrypted(bob, 'operation', first.id)).toBeUndefined();
    const third = await sealer.seal({ ...input, userId: bob, sessionId: 'bob-session' });
    expect(third.sequence).toBe('3');
    keys.lock();
    db.close();
    await db.open();
    expect((await db.deliveryBytes()).find(row => row.id === first.id)?.envelope).toEqual(original);
    expect((await db.meta.get('device-chain'))?.sequence).toBe('3');
    db.close();
  });

  it('rolls back records, envelope and head when the second write fails, then retries without a gap', async () => {
    const { db, sealer } = await setup();
    const fail = () => { throw new Error('Simulated write failure'); };
    db.delivery_queue.hook('creating', fail);
    await expect(sealer.seal(input)).rejects.toThrow(/write failure/);
    expect(await db.records.count()).toBe(0);
    expect(await db.delivery_queue.count()).toBe(0);
    expect((await db.meta.get('device-chain'))?.sequence).toBe('0');
    db.delivery_queue.hook('creating').unsubscribe(fail);
    expect((await sealer.seal(input)).sequence).toBe('1');
    db.close();
  });

  it('rejects lease expiry and logout between preparation and commit without consuming sequence', async () => {
    let calls = 0;
    const { db, keys, sealer } = await setup(() => ++calls <= 1 ? 0 : 100_000);
    await expect(sealer.seal(input)).rejects.toThrow(/lease/);
    expect(await db.records.count()).toBe(0);
    expect((await db.meta.get('device-chain'))?.sequence).toBe('0');
    const stable = new OfflineSealer(db, keys, new OfflineLease(db),
      { certificate: 'opaque', publication, trustedSigner: trusted.publicKey, trustedSigningKeyId: 'trusted' });
    const pending = stable.seal(input);
    keys.lock();
    await expect(pending).rejects.toThrow(/bloqueada|changed/);
    expect(await db.delivery_queue.count()).toBe(0);
    db.close();
  });

  it('aborts if the fence is stolen or lease expires during IndexedDB writes', async () => {
    let now = 0;
    const { db, sealer } = await setup(() => now);
    const expire = () => { now = 100_000; };
    db.delivery_queue.hook('creating', expire);
    await expect(sealer.seal(input)).rejects.toThrow(/lease/);
    expect(await db.records.count()).toBe(0);
    expect(await db.delivery_queue.count()).toBe(0);
    expect((await db.meta.get('device-chain'))?.sequence).toBe('0');
    db.delivery_queue.hook('creating').unsubscribe(expire);
    expect((await sealer.seal(input)).sequence).toBe('1');
    db.close();
  });
});
