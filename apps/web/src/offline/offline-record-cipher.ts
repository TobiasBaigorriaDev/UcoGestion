import { bytes, encode } from './offline-crypto';

export interface RecordContext {
  readonly organizationId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly kind: string;
  readonly id: string;
}

export class OfflineRecordCipher {
  private aad(context: RecordContext): ArrayBuffer {
    return bytes(encode({ domain: 'UcoNext:identity-record', schema: 1, organizationId: context.organizationId,
      deviceId: context.deviceId, userId: context.userId, kind: context.kind, id: context.id }));
  }

  private validateKey(key: CryptoKey): void {
    if (key.algorithm.name !== 'AES-GCM' || !('length' in key.algorithm) || key.algorithm.length !== 256) {
      throw new Error('Identity records require AES-256-GCM.');
    }
  }

  async encrypt(key: CryptoKey, context: RecordContext, plaintext: Uint8Array): Promise<Uint8Array> {
    this.validateKey(key);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad(context), tagLength: 128 }, key, bytes(plaintext));
    const result = new Uint8Array(13 + ciphertext.byteLength);
    result[0] = 1;
    result.set(iv, 1);
    result.set(new Uint8Array(ciphertext), 13);
    return result;
  }

  async decrypt(key: CryptoKey, context: RecordContext, ciphertext: Uint8Array): Promise<Uint8Array> {
    this.validateKey(key);
    if (ciphertext[0] !== 1 || ciphertext.length < 29) throw new Error('Invalid encrypted record version.');
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ciphertext.slice(1, 13),
      additionalData: this.aad(context), tagLength: 128 }, key, bytes(ciphertext.slice(13))));
  }
}
