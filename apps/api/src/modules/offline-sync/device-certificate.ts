import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes } from 'node:crypto';

export interface DeviceCertificateClaims {
  readonly version: 1;
  readonly deviceId: string;
  readonly organizationId: string;
  readonly thumbprint: string;
}

const aad = Buffer.from('uconext:device-delivery-certificate:v1');

export class DeviceCertificate {
  constructor(private readonly secret: Buffer) {
    if (secret.length !== 32) throw new Error('Device certificate key must be 32 bytes.');
  }

  thumbprint(publicKeyPem: string): string {
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n/.test(publicKeyPem)) {
      throw new Error('Device public key must be a public SPKI PEM.');
    }
    let key: ReturnType<typeof createPublicKey>;
    try { key = createPublicKey(publicKeyPem); }
    catch { throw new Error('Device public key must be ECDSA P-256.'); }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('Device public key must be ECDSA P-256.');
    }
    const der = key.export({ format: 'der', type: 'spki' });
    return createHash('sha256').update(der).digest('base64url');
  }

  issue(claims: Omit<DeviceCertificateClaims, 'version'>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secret, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ version: 1, ...claims }), 'utf8'), cipher.final()]);
    return `v1.${Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url')}`;
  }

  open(token: string): DeviceCertificateClaims {
    if (!/^v1\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid device certificate.');
    const bytes = Buffer.from(token.slice(3), 'base64url');
    if (bytes.length < 29) throw new Error('Invalid device certificate.');
    const decipher = createDecipheriv('aes-256-gcm', this.secret, bytes.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(-16));
    const claims: unknown = JSON.parse(Buffer.concat([
      decipher.update(bytes.subarray(12, -16)), decipher.final(),
    ]).toString('utf8'));
    if (!claims || typeof claims !== 'object' || !('version' in claims) || claims.version !== 1 ||
      !('deviceId' in claims) || typeof claims.deviceId !== 'string' ||
      !('organizationId' in claims) || typeof claims.organizationId !== 'string' ||
      !('thumbprint' in claims) || typeof claims.thumbprint !== 'string') {
      throw new Error('Invalid device certificate.');
    }
    return claims as DeviceCertificateClaims;
  }
}
