import { createPrivateKey, createPublicKey, sign } from 'node:crypto';

import { z } from 'zod';

import { RsaSyncEnvelopeDecryptor } from './sync-envelope-decryptor.js';

const inventorySchema = z.strictObject({ activeKeyId: z.string().min(1), keys: z.record(z.string().min(1), z.string().min(1)) });

export class OfflineKeysUnavailableError extends Error {
  constructor(message = 'Offline key custody unavailable.') { super(message); }
}

/** Secret-manager injection; no ephemeral production keys or private HTTP material. */
export function loadOfflineKeys(environment: NodeJS.ProcessEnv = process.env) {
  try {
    const signingKey = createPrivateKey(environment.OFFLINE_SIGNING_PRIVATE_KEY ?? '');
    const keyId = environment.OFFLINE_SIGNING_KEY_ID;
    if (!keyId || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) || signingKey.asymmetricKeyType !== 'ec' ||
      signingKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new OfflineKeysUnavailableError();
    const inventory = inventorySchema.parse(JSON.parse(environment.OFFLINE_INGESTION_KEYS ?? ''));
    const signer = { keyId, publicKeyPem: createPublicKey(signingKey).export({ type: 'spki', format: 'pem' }).toString(),
      sign: (payload: string) => sign('sha256', Buffer.from(payload), signingKey).toString('base64') };
    return { signingKey, signer, ingestion: new RsaSyncEnvelopeDecryptor(inventory, signingKey, keyId) };
  } catch { throw new OfflineKeysUnavailableError(); }
}

/** Rotation retains historical ACK signing keys for still-exposed grants. */
export function loadOfflineAckKey(keyId:string, environment:NodeJS.ProcessEnv=process.env) {
  const current=loadOfflineKeys(environment);
  if (keyId===current.signer.keyId) return current.signingKey;
  try {
    const inventory=z.record(z.string(),z.string()).parse(JSON.parse(environment.OFFLINE_ACK_SIGNING_KEYS ?? '{}'));
    const pem=inventory[keyId];
    if (!pem) throw new Error();
    const key=createPrivateKey(pem);
    if (key.asymmetricKeyType!=='ec' || key.asymmetricKeyDetails?.namedCurve!=='prime256v1') throw new Error();
    return key;
  } catch { throw new OfflineKeysUnavailableError('Historical ACK key unavailable.'); }
}
