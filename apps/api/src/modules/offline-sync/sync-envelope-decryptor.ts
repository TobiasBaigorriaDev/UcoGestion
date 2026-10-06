import { constants, createPrivateKey, createPublicKey, privateDecrypt, sign, type KeyObject } from 'node:crypto';

export interface SyncEnvelopeDecryptorPort {
  unwrap(keyId: string, wrappedCek: Uint8Array): Promise<Uint8Array>;
}
export class IngestionKeyUnavailableError extends Error {
  constructor() { super('Ingestion key temporarily unavailable.'); }
}

/** Supplied by protected secret custody; never log or expose this snapshot via HTTP. */
export interface IngestionKeyBackup {
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, string>>;
}

/** Conservative retention: every provisioned key may have produced an offline envelope.
 * Rotation/restore must be persisted in secret custody before publishing a new bootstrap.
 * No runtime-generated ephemeral private key and no wall-clock retirement deadline.
 */
export class RsaSyncEnvelopeDecryptor implements SyncEnvelopeDecryptorPort {
  private state: IngestionKeyBackup;

  constructor(state: IngestionKeyBackup, private readonly signingKey: KeyObject, private readonly signingKeyId: string) {
    this.validate(state);
    if (signingKey.asymmetricKeyType !== 'ec' || signingKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('Publication signing key must be ECDSA P-256.');
    }
    this.state = structuredClone(state);
  }

  private validate(state: IngestionKeyBackup): void {
    if (!Object.hasOwn(state.keys, state.activeKeyId)) throw new Error('Active ingestion key unavailable.');
    for (const pem of Object.values(state.keys)) {
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 3072) {
        throw new Error('Ingestion keys must be RSA-OAEP-3072/SHA-256.');
      }
    }
  }

  publication(): { payload: string; signature: string; signingKeyId: string } {
    const payload = JSON.stringify({ version: 1, keyId: this.state.activeKeyId,
      algorithm: 'RSA-OAEP-3072/SHA-256', publicKey: createPublicKey(this.state.keys[this.state.activeKeyId] ?? '')
        .export({ type: 'spki', format: 'pem' }).toString() });
    return { payload, signature: sign('sha256', Buffer.from(payload), { key: this.signingKey, dsaEncoding: 'ieee-p1363' }).toString('base64'), signingKeyId: this.signingKeyId };
  }

  async unwrap(keyId: string, wrappedCek: Uint8Array): Promise<Uint8Array> {
    if (!Object.hasOwn(this.state.keys, keyId)) throw new IngestionKeyUnavailableError();
    const cek = privateDecrypt({ key: this.state.keys[keyId] ?? '',
      padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrappedCek);
    if (cek.length !== 32) { cek.fill(0); throw new Error('Invalid envelope CEK.'); }
    return cek;
  }

  rotate(keyId: string, privateKeyPem: string): void {
    if (Object.hasOwn(this.state.keys, keyId)) throw new Error('Ingestion key ID already exists.');
    this.restore({ activeKeyId: keyId, keys: { ...this.state.keys, [keyId]: privateKeyPem } });
  }

  backup(): IngestionKeyBackup { return structuredClone(this.state); }

  restore(snapshot: IngestionKeyBackup): void {
    this.validate(snapshot);
    for (const [id, pem] of Object.entries(this.state.keys)) {
      if (!Object.hasOwn(snapshot.keys, id) || createPublicKey(pem).export({ type: 'spki', format: 'pem' }) !==
          createPublicKey(snapshot.keys[id] ?? '').export({ type: 'spki', format: 'pem' })) {
        throw new Error('Restore must preserve every historical ingestion key.');
      }
    }
    this.state = structuredClone(snapshot);
  }

  retire(keyId: string): never {
    if (!Object.hasOwn(this.state.keys, keyId)) throw new Error('Ingestion key unavailable.');
    throw new Error('Cannot retire ingestion keys while exposures or possible envelopes may exist.');
  }
}
