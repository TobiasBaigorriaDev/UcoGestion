import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSyncEnvelope } from '../src/offline/sync-envelope.js';
import { base64, bytes, encode, hash, unbase64 } from '../src/offline/offline-crypto.js';
import { RsaSyncEnvelopeDecryptor } from '../../api/src/modules/offline-sync/sync-envelope-decryptor.js';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
describe('T190A hybrid envelope', () => {
  let rsa: CryptoKeyPair;
  let signer: CryptoKeyPair;
  let publication: { payload: string; signature: string; signingKeyId: string };
  beforeAll(async () => {
    rsa = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['wrapKey', 'unwrapKey']);
    signer = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const spki = base64(new Uint8Array(await crypto.subtle.exportKey('spki', rsa.publicKey)));
    const payload = JSON.stringify({ version: 1, keyId: 'key', algorithm: 'RSA-OAEP-3072/SHA-256', publicKey: `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----` });
    publication = { payload, signature: base64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.privateKey, bytes(new TextEncoder().encode(payload))))), signingKeyId: 'trusted' };
  });
  const operation = { id: '11111111-1111-4111-8111-111111111111', actorId: 'alice', organizationId: 'tenant',
    deviceId: 'device', sequence: '1', previousHash: null, payload: { amount: '10.00' }, grant: { version: 1 }, configVersion: '1' };

  it('exposes minimum routing only and duplicates authenticated routing inside server encryption', async () => {
    const serialized = await buildSyncEnvelope(operation, 'opaque-certificate', signer.privateKey, publication, signer.publicKey, 'trusted');
    const outer = JSON.parse(new TextDecoder().decode(serialized));
    expect(Object.keys(outer).sort()).toEqual(['certificate', 'ciphertext', 'ciphertextHash', 'iv', 'keyId', 'operationId', 'signature', 'version', 'wrappedCek'].sort());
    expect(new TextDecoder().decode(serialized)).not.toMatch(/alice|tenant|amount|sequence/);
    const { signature, ...unsigned } = outer;
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, signer.publicKey, bytes(unbase64(signature)), bytes(encode(unsigned)))).toBe(true);
    const cek = await crypto.subtle.unwrapKey('raw', bytes(unbase64(outer.wrappedCek)), rsa.privateKey, 'RSA-OAEP', { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const routing = { version: 1, keyId: 'key', operationId: operation.id, certificate: 'opaque-certificate' };
    const inner = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(unbase64(outer.iv)), additionalData: bytes(encode(routing)) }, cek, bytes(unbase64(outer.ciphertext)))));
    expect(inner.routing).toEqual(routing);
    expect(inner.operation).toEqual(operation);
    expect(inner.payloadHash).toBe(await hash(encode(operation)));
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, signer.publicKey, bytes(unbase64(inner.signature)), bytes(unbase64(inner.payloadHash)))).toBe(true);
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(unbase64(outer.iv)), additionalData: bytes(encode({ ...routing, operationId: 'altered' })) }, cek, bytes(unbase64(outer.ciphertext)))).rejects.toThrow();
  });

  it('rejects forged publications and nested reusable credentials before sealing', async () => {
    await expect(buildSyncEnvelope(operation, 'opaque', signer.privateKey, { ...publication, payload: publication.payload + ' ' }, signer.publicKey, 'trusted')).rejects.toThrow();
    await expect(buildSyncEnvelope(operation, 'opaque', signer.privateKey, publication, signer.publicKey, 'other')).rejects.toThrow();
    for (const field of ['password', 'sessionToken', 'authorization', 'accessToken', 'refreshToken', 'cookie', 'csrfToken']) {
      await expect(buildSyncEnvelope({ ...operation, payload: { nested: { [field]: 'secret' } } }, 'opaque', signer.privateKey, publication, signer.publicKey, 'trusted')).rejects.toThrow(/credentials/);
    }
  });

  it('interoperates with the server publication and restored RSA decryptor without regenerating envelope bytes', async () => {
    const rsaKeys = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const signingKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const custody = new RsaSyncEnvelopeDecryptor({ activeKeyId: 'server-key', keys: {
      'server-key': rsaKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    } }, signingKeys.privateKey, 'server-signer');
    const trustedKey = await crypto.subtle.importKey('spki', bytes(new Uint8Array(signingKeys.publicKey.export({ format: 'der', type: 'spki' }))),
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const envelope = await buildSyncEnvelope(operation, 'opaque', signer.privateKey, custody.publication(), trustedKey, 'server-signer');
    const outer = JSON.parse(new TextDecoder().decode(envelope));
    const restored = new RsaSyncEnvelopeDecryptor(custody.backup(), signingKeys.privateKey, 'server-signer');
    const raw = await restored.unwrap(outer.keyId, unbase64(outer.wrappedCek));
    const cek = await crypto.subtle.importKey('raw', bytes(raw), 'AES-GCM', false, ['decrypt']);
    raw.fill(0);
    const routing = { version: 1, keyId: 'server-key', operationId: operation.id, certificate: 'opaque' };
    const inner = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(unbase64(outer.iv)),
      additionalData: bytes(encode(routing)) }, cek, bytes(unbase64(outer.ciphertext)))));
    expect(inner.operation).toEqual(operation);
    expect(inner.routing).toEqual(routing);
  });
});
