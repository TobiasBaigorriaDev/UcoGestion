import { constants, generateKeyPairSync, publicEncrypt, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RsaSyncEnvelopeDecryptor } from '../src/modules/offline-sync/sync-envelope-decryptor.js';

describe('T189A ingestion key custody', () => {
  const signer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const first = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const second = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const pem = (key: typeof first.privateKey) => key.export({ format: 'pem', type: 'pkcs8' }).toString();

  it('publishes signed RSA-OAEP keys and retains decryptability through rotation and restore', async () => {
    const keys = new RsaSyncEnvelopeDecryptor({ activeKeyId: 'first', keys: { first: pem(first.privateKey) } }, signer.privateKey, 'signer');
    const publication = keys.publication();
    expect(verify('sha256', Buffer.from(publication.payload), { key: signer.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(publication.signature, 'base64'))).toBe(true);
    const wrapped = publicEncrypt({ key: first.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.alloc(32, 7));
    keys.rotate('second', pem(second.privateKey));
    expect(await keys.unwrap('first', wrapped)).toEqual(Buffer.alloc(32, 7));
    const restored = new RsaSyncEnvelopeDecryptor(keys.backup(), signer.privateKey, 'signer');
    expect(await restored.unwrap('first', wrapped)).toEqual(Buffer.alloc(32, 7));
    expect(() => restored.retire('first')).toThrow(/possible envelopes/);
    expect(() => restored.retire('second')).toThrow();
    await expect(restored.unwrap('missing', wrapped)).rejects.toThrow(/unavailable/);
    await expect(restored.unwrap('first', Buffer.alloc(384))).rejects.toThrow();
  });

  it('rejects weak keys and refuses restore that omits any historical key', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => new RsaSyncEnvelopeDecryptor({ activeKeyId: 'weak', keys: { weak: pem(weak.privateKey) } }, signer.privateKey, 'signer')).toThrow(/3072/);
    const keys = new RsaSyncEnvelopeDecryptor({ activeKeyId: 'first', keys: { first: pem(first.privateKey) } }, signer.privateKey, 'signer');
    keys.publication();
    expect(() => keys.restore({ activeKeyId: 'second', keys: { second: pem(second.privateKey) } })).toThrow(/historical/);
  });
});
