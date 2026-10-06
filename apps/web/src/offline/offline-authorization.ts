import { offlineBootstrapPayloadSchema, offlineGrantClaimsSchema, signedOfflineDocumentSchema,
  type OfflineBootstrapPayload, type OfflineGrantClaims } from '@uconext/shared';
import { z } from 'zod';

import { base64, bytes, encode, unbase64 } from './offline-crypto';
import { OfflineDatabase } from './offline-database';
import { OfflineKeys } from './offline-keys';
import { OfflineRecordCipher } from './offline-record-cipher';

const storedSchema = z.strictObject({ bootstrap: signedOfflineDocumentSchema, grant: z.string().min(1) });
const headerSchema = z.strictObject({ alg: z.literal('ES256'), kid: z.string(), typ: z.literal('uco-offline-grant+jwt') });
export interface OfflineAuthorizationContext {
  readonly bootstrap: OfflineBootstrapPayload;
  readonly claims: OfflineGrantClaims;
  readonly grant: string;
  readonly authorizationBytes?: Uint8Array;
  readonly knownExpired?: boolean;
}

/** Configuration signatures use ASN.1 DER; Web Crypto expects IEEE-P1363. */
function derSignature(signature: Uint8Array): Uint8Array {
  if (signature[0] !== 0x30 || signature[1] !== signature.length - 2) throw new Error('Invalid bootstrap signature.');
  const result = new Uint8Array(64);
  let offset = 2;
  for (const target of [0, 32]) {
    if (signature[offset++] !== 2) throw new Error('Invalid bootstrap signature.');
    const length = signature[offset++];
    if (!length || length > 33 || offset + length > signature.length) throw new Error('Invalid bootstrap signature.');
    let value = signature.slice(offset, offset + length);
    if (value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw new Error('Invalid bootstrap signature.');
    result.set(value, target + 32 - value.length);
    offset += length;
  }
  if (offset !== signature.length) throw new Error('Invalid bootstrap signature.');
  return result;
}

function urlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid grant encoding.');
  return unbase64(value.replace(/-/g, '+').replace(/_/g, '/'));
}

export class OfflineAuthorization {
  private readonly cipher = new OfflineRecordCipher();
  constructor(private readonly db: OfflineDatabase, private readonly keys: OfflineKeys,
    private readonly trustedSigner: CryptoKey, private readonly trustedKeyId: string,
    private readonly now: () => number = Date.now) {}

  async install(userId: string, bootstrap: z.infer<typeof signedOfflineDocumentSchema>, grant: string): Promise<void> {
    const stored = storedSchema.parse({ bootstrap, grant });
    const dek = this.keys.dekFor(userId);
    const context = await this.verify(userId, stored);
    this.assertCurrent(context);
    const encrypted = await this.cipher.encrypt(dek, this.recordContext(userId), encode(stored));
    await this.db.transaction('rw', this.db.records, async () => {
      if (this.keys.dekFor(userId) !== dek) throw new Error('Offline identity changed.');
      this.assertCurrent(context);
      await this.db.putEncrypted(userId, 'authorization', 'current', encrypted);
      if (this.keys.dekFor(userId) !== dek) throw new Error('Offline identity changed.');
    });
  }

  async read(userId: string): Promise<OfflineAuthorizationContext> {
    const dek = this.keys.dekFor(userId);
    const encrypted = await this.db.getEncrypted(userId, 'authorization', 'current');
    if (!encrypted) throw new Error('Offline bootstrap and grant required.');
    const stored = storedSchema.parse(JSON.parse(new TextDecoder().decode(
      await this.cipher.decrypt(dek, this.recordContext(userId), encrypted))));
    const context = await this.verify(userId, stored);
    if (this.keys.dekFor(userId) !== dek) throw new Error('Offline identity changed.');
    return { ...context, authorizationBytes: encrypted,
      knownExpired: Boolean(await this.db.getEncrypted(userId, 'expired-grant', context.claims.grantId)) };
  }

  async require(userId: string): Promise<OfflineAuthorizationContext> {
    const context = await this.read(userId);
    if (!context.knownExpired && this.now() >= context.claims.exp * 1000) {
      const dek = this.keys.dekFor(userId);
      const id = context.claims.grantId;
      const encrypted = await this.cipher.encrypt(dek, { organizationId: this.db.organizationId,
        deviceId: this.db.deviceId, userId, kind: 'expired-grant', id }, encode(true));
      await this.db.transaction('rw', this.db.records, async () => {
        if (this.keys.dekFor(userId) !== dek) throw new Error('Offline identity changed.');
        await this.db.putEncrypted(userId, 'expired-grant', id, encrypted);
      });
    }
    this.assertCurrent(context); return context;
  }

  async assertUsable(userId: string, context: OfflineAuthorizationContext): Promise<void> {
    this.assertCurrent(context);
    if (await this.db.getEncrypted(userId, 'expired-grant', context.claims.grantId)) {
      throw new Error('La credencial offline venció. Sincronizá online.');
    }
  }

  assertCurrent(context: OfflineAuthorizationContext): void {
    if (context.knownExpired || this.now() < context.claims.iat * 1000 || this.now() >= context.claims.exp * 1000) {
      throw new Error('La credencial offline venció. Sincronizá online.');
    }
  }

  private recordContext(userId: string) {
    return { organizationId: this.db.organizationId, deviceId: this.db.deviceId, userId, kind: 'authorization', id: 'current' };
  }

  private async verify(userId: string, stored: z.infer<typeof storedSchema>): Promise<OfflineAuthorizationContext> {
    if (stored.bootstrap.signingKeyId !== this.trustedKeyId || !await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, this.trustedSigner, bytes(derSignature(unbase64(stored.bootstrap.signature))),
      bytes(new TextEncoder().encode(stored.bootstrap.payload)))) throw new Error('Invalid bootstrap signature.');
    const bootstrap = offlineBootstrapPayloadSchema.parse(JSON.parse(stored.bootstrap.payload));
    const parts = stored.grant.split('.');
    const [header, payload, signature] = parts;
    if (parts.length !== 3 || !header || !payload || !signature) throw new Error('Invalid grant.');
    const parsedHeader = headerSchema.parse(JSON.parse(new TextDecoder().decode(urlBytes(header))));
    if (parsedHeader.kid !== this.trustedKeyId || !await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, this.trustedSigner, bytes(urlBytes(signature)),
      bytes(new TextEncoder().encode(`${header}.${payload}`)))) throw new Error('Invalid grant signature.');
    const claims = offlineGrantClaimsSchema.parse(JSON.parse(new TextDecoder().decode(urlBytes(payload))));
    const bootstrapHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      bytes(new TextEncoder().encode(stored.bootstrap.payload)))), byte => byte.toString(16).padStart(2, '0')).join('');
    const device = await this.db.device_keys.get('device');
    if (!device) throw new Error('Registered device key required.');
    const thumbprint = base64(new Uint8Array(await crypto.subtle.digest('SHA-256',
      await crypto.subtle.exportKey('spki', device.publicKey)))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    for (const [left, right] of [[claims.organizationId, this.db.organizationId], [claims.deviceId, this.db.deviceId],
      [claims.actorUserId, userId], [claims.thumbprint, thumbprint], [claims.bootstrapHash, bootstrapHash],
      [bootstrap.organizationId, claims.organizationId], [bootstrap.deviceId, claims.deviceId],
      [bootstrap.actorUserId, claims.actorUserId], [bootstrap.grantId, claims.grantId], [bootstrap.branchId, claims.branchId],
      [bootstrap.epoch, claims.epoch], [bootstrap.configurationVersion, claims.configurationVersion], [bootstrap.role, claims.role]]) {
      if (left !== right) throw new Error('Offline authorization context mismatch.');
    }
    if (bootstrap.permissions.canDiscount !== claims.permissions.canDiscount ||
      JSON.stringify([...claims.cashRegisterIds].sort()) !== JSON.stringify(bootstrap.configuration.cashRegisters.map(row => row.id).sort())) {
      throw new Error('Offline authorization scope mismatch.');
    }
    return { bootstrap, claims, grant: stored.grant };
  }
}
