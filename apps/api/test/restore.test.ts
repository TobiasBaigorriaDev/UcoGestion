import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { validateKeyReferences, validateRestoreTarget } from '../src/operations/restore.js';

it('T232 refuses primary targets and requires ingestion and ACK private keys to match referenced public keys', async () => {
  expect(() => validateRestoreTarget('postgresql://admin:pw@primary:5432/live','postgresql://admin:pw@primary:5432/live')).toThrow();
  expect(() => validateRestoreTarget('postgresql://admin:pw@isolated:5432/live','postgresql://admin:pw@primary:5432/live')).toThrow();
  const rsa=generateKeyPairSync('rsa',{modulusLength:3072}), ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const pem=(key:typeof ec.privateKey) => key.export({format:'pem',type:'pkcs8'}).toString();
  const pub=(key:typeof ec.publicKey) => key.export({format:'pem',type:'spki'}).toString();
  const environment={OFFLINE_SIGNING_KEY_ID:'ack-old',OFFLINE_SIGNING_PRIVATE_KEY:pem(ec.privateKey),
    OFFLINE_INGESTION_KEYS:JSON.stringify({activeKeyId:'rsa-old',keys:{'rsa-old':pem(rsa.privateKey)}}),
    OFFLINE_ACK_SIGNING_KEYS:'{}',DEVICE_CERTIFICATE_KEY:randomBytes(32).toString('base64url')};
  await expect(validateKeyReferences(environment,[{key_id:'rsa-old',public_key_pem:pub(rsa.publicKey)}],[{key_id:'ack-old',public_key_pem:pub(ec.publicKey)}])).resolves.toBeUndefined();
  await expect(validateKeyReferences(environment,[{key_id:'missing',public_key_pem:pub(rsa.publicKey)}],[])).rejects.toThrow();
  await expect(validateKeyReferences(environment,[],[{key_id:'missing',public_key_pem:pub(ec.publicKey)}])).rejects.toThrow();
  const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  await expect(validateKeyReferences(environment,[],[{key_id:'ack-old',public_key_pem:pub(other.publicKey)}])).rejects.toThrow();
});
