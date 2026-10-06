import 'fake-indexeddb/auto';

import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import type { OfflineBootstrapPayload, OfflineGrantClaims } from '@uconext/shared';

import { OfflineAuthorization } from '../src/offline/offline-authorization.js';
import { OfflineDatabase } from '../src/offline/offline-database.js';
import { OfflineKeys } from '../src/offline/offline-keys.js';

export const org = '11111111-1111-4111-8111-111111111111';
export const device = '22222222-2222-4222-8222-222222222222';
export const actor = '33333333-3333-4333-8333-333333333333';
export const branch = '44444444-4444-4444-8444-444444444444';
const grantId = '55555555-5555-4555-8555-555555555555';
const signer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 3072 });
export const now = Date.parse('2026-10-06T18:00:00.000Z');

export async function authorizationFixture(configure?: (bootstrap: OfflineBootstrapPayload) => void) {
  const db = new OfflineDatabase(org, device); await db.open();
  const keys = new OfflineKeys(db); await keys.create(actor, 'offline-pin');
  const publicKey = (await db.device_keys.get('device'))?.publicKey;
  if (!publicKey) throw new Error('Missing local key');
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  const ingestionPayload = JSON.stringify({ version: 1, keyId: 'ingestion', algorithm: 'RSA-OAEP-3072/SHA-256',
    publicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
  const bootstrap: OfflineBootstrapPayload = { version: 1, organizationId: org, deviceId: device, actorUserId: actor,
    branchId: branch, grantId, epoch: '1', configurationVersion: '1', role: 'OWNER', permissions: { canDiscount: true },
    timezone: 'UTC', serverTime: new Date(now).toISOString(), stock: [],
    configuration: { currency: 'ARS', items: [{ id: org, name: 'Producto', sku: null, barcode: null,
      type: 'PRODUCT', baseUnit: 'UNIT', trackInventory: false, price: '10.00', priceVersion: 1 }], categories: [], branches: [{ id: branch, name: 'Main' }],
      cashRegisters: [{ id: '66666666-6666-4666-8666-666666666666', name: 'Register', branchId: branch }], paymentMethods: ['CASH'] },
    ingestionKey: { payload: ingestionPayload, signature: sign('sha256', Buffer.from(ingestionPayload),
      { key: signer.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64'), signingKeyId: 'trusted' },
    ackKey: { algorithm: 'ES256', keyId: 'trusted', publicKeyPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
  const signedBootstrap = (value = bootstrap) => {
    const payload = JSON.stringify(value);
    return { payload, signature: sign('sha256', Buffer.from(payload), signer.privateKey).toString('base64'), signingKeyId: 'trusted' };
  };
  configure?.(bootstrap);
  const signed = signedBootstrap();
  const claims: OfflineGrantClaims = { version: 1, grantId, organizationId: org, deviceId: device, actorUserId: actor,
    branchId: branch, epoch: bootstrap.epoch, configurationVersion: bootstrap.configurationVersion,
    role: bootstrap.role, permissions: bootstrap.permissions,
    cashRegisterIds: bootstrap.configuration.cashRegisters.map(row => row.id),
    thumbprint: createHash('sha256').update(Buffer.from(spki)).digest('base64url'),
    bootstrapHash: createHash('sha256').update(signed.payload).digest('hex'), iat: now / 1000, exp: now / 1000 + 72 * 60 * 60 };
  const jwt = (value = claims) => {
    const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'trusted', typ: 'uco-offline-grant+jwt' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`),
      { key: signer.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  const trusted = await crypto.subtle.importKey('spki', signer.publicKey.export({ type: 'spki', format: 'der' }),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const authorization = new OfflineAuthorization(db, keys, trusted, 'trusted', () => now);
  return { db, keys, authorization, bootstrap, claims, signed, signedBootstrap, jwt, trusted };
}
