import { constants, createPublicKey, publicEncrypt, randomBytes, sign, verify } from 'node:crypto';
import { loadOfflineAckKey, loadOfflineKeys } from './offline-key-custody.js';

export interface RecoveryKeyReference { key_id: string; public_key_pem: string }
export async function validateKeyReferences(environment: NodeJS.ProcessEnv, ingestion: RecoveryKeyReference[], ack: RecoveryKeyReference[]): Promise<void> {
  const keys = loadOfflineKeys(environment);
  const certificate = Buffer.from(environment.DEVICE_CERTIFICATE_KEY ?? '', 'base64url');
  if (certificate.length !== 32) throw new Error('Device certificate custody unavailable.');
  const challenge = randomBytes(32);
  for (const reference of ingestion) {
    const wrapped = publicEncrypt({key:reference.public_key_pem,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},challenge);
    if (!Buffer.from(await keys.ingestion.unwrap(reference.key_id,wrapped)).equals(challenge)) throw new Error('Ingestion recovery failed.');
  }
  for (const reference of ack) {
    const key = loadOfflineAckKey(reference.key_id,environment);
    if (createPublicKey(key).export({format:'pem',type:'spki'}).toString() !== reference.public_key_pem ||
      !verify('sha256',challenge,reference.public_key_pem,sign('sha256',challenge,key))) throw new Error('Historical ACK recovery failed.');
  }
  // Validate every retained ACK key, even when there is no longer an online reference.
  const retained: unknown = JSON.parse(environment.OFFLINE_ACK_SIGNING_KEYS ?? '{}');
  if (typeof retained !== 'object' || retained === null || Array.isArray(retained)) throw new Error('Invalid ACK inventory.');
  for (const id of Object.keys(retained)) loadOfflineAckKey(id,environment);
}
