import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { DeviceCertificate } from '../src/modules/offline-sync/device-certificate.js';

describe('T185 device certificate', () => {
  const secret = randomBytes(32);
  const certificate = new DeviceCertificate(secret);
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();

  it('binds opaque authenticated contents to the registered key', () => {
    const thumbprint = certificate.thumbprint(publicKey);
    const token = certificate.issue({ deviceId: 'device', organizationId: 'tenant', thumbprint });
    expect(token).not.toContain('device');
    expect(token).not.toContain('tenant');
    expect(certificate.open(token)).toMatchObject({ deviceId: 'device', organizationId: 'tenant', thumbprint, version: 1 });
    expect(() => certificate.open(token.slice(0, -2) + 'xx')).toThrow();
  });

  it('rejects a non-ECDSA P-256 public key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => certificate.thumbprint(rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString())).toThrow();
  });
});
