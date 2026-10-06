import { base64, bytes, encode, hash, unbase64 } from './offline-crypto';

export interface SignedIngestionPublication {
  readonly payload: string;
  readonly signature: string;
  readonly signingKeyId: string;
}

function rejectCredentials(value: unknown): void {
  if (typeof value === 'string' && /^Bearer\s+/i.test(value)) throw new Error('Reusable credentials are forbidden in offline envelopes.');
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(password|session|sessiontoken|onlinesession|authorization|bearer|token|accesstoken|refreshtoken|cookie|csrftoken)$/i.test(key.replace(/[_-]/g, ''))) {
      throw new Error('Reusable credentials are forbidden in offline envelopes.');
    }
    rejectCredentials(nested);
  }
}

export async function buildSyncEnvelope<T extends Readonly<{ id: string }>>(
  operation: T, certificate: string, deviceSigner: CryptoKey,
  publication: SignedIngestionPublication, trustedSigner: CryptoKey, trustedSigningKeyId: string,
): Promise<Uint8Array> {
  rejectCredentials(operation);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operation.id)) throw new Error('Invalid operation UUID.');
  if (publication.signingKeyId !== trustedSigningKeyId || !await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, trustedSigner, bytes(unbase64(publication.signature)),
    bytes(new TextEncoder().encode(publication.payload)),
  )) throw new Error('Invalid ingestion key publication signature.');
  const published: unknown = JSON.parse(publication.payload);
  if (!published || typeof published !== 'object' || !('version' in published) || published.version !== 1 ||
    !('algorithm' in published) || published.algorithm !== 'RSA-OAEP-3072/SHA-256' ||
    !('keyId' in published) || typeof published.keyId !== 'string' ||
    !('publicKey' in published) || typeof published.publicKey !== 'string') throw new Error('Invalid ingestion key publication.');
  const publicKey = await crypto.subtle.importKey('spki', bytes(unbase64(published.publicKey
    .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, ''))),
  { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey']);
  const algorithm = publicKey.algorithm as RsaHashedKeyAlgorithm;
  if (algorithm.modulusLength !== 3072 || algorithm.hash.name !== 'SHA-256') throw new Error('Invalid ingestion RSA key.');
  const routing = { version: 1, keyId: published.keyId, operationId: operation.id, certificate };
  const payloadHash = await hash(encode(operation));
  const signature = base64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, deviceSigner, bytes(unbase64(payloadHash)))));
  const cek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: bytes(encode(routing)), tagLength: 128 }, cek, bytes(encode({ routing, operation, payloadHash, signature }))));
  const wrappedCek = new Uint8Array(await crypto.subtle.wrapKey('raw', cek, publicKey, 'RSA-OAEP'));
  const unsigned = { ...routing, iv: base64(iv), wrappedCek: base64(wrappedCek),
    ciphertext: base64(ciphertext), ciphertextHash: await hash(ciphertext) };
  const outerSignature = base64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, deviceSigner, bytes(encode(unsigned)))));
  return encode({ ...unsigned, signature: outerSignature });
}
