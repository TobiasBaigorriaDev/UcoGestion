import { createCipheriv, createHash, generateKeyPairSync, publicEncrypt, randomBytes, randomUUID, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DeviceCertificate } from '../src/modules/offline-sync/device-certificate.js';
import { HistoricalEnvelopeValidator, canonicalEnvelopeJson } from '../src/modules/offline-sync/historical-envelope-validator.js';
import { RsaSyncEnvelopeDecryptor } from '../src/modules/offline-sync/sync-envelope-decryptor.js';

const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 3072 });
const pem = ec.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const certificates = new DeviceCertificate(randomBytes(32));
const org = randomUUID(), actor = randomUUID(), device = randomUUID(), branch = randomUUID(), register = randomUUID(), grantId = randomUUID();
const certificate = certificates.issue({ organizationId: org, deviceId: device, thumbprint: certificates.thumbprint(pem) });
const custody = new RsaSyncEnvelopeDecryptor({ activeKeyId: 'rsa', keys: {
  rsa: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
} }, ec.privateKey, 'trusted');
const claims = { version: 1, grantId, organizationId: org, actorUserId: actor, deviceId: device, branchId: branch,
  epoch: '1', configurationVersion: '1', cashRegisterIds: [register], role: 'OWNER', permissions: { canDiscount: true },
  thumbprint: certificates.thumbprint(pem), bootstrapHash: 'a'.repeat(64), iat: 1700000000, exp: 1700259200 };
const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'uco-offline-grant+jwt', kid: 'trusted' })).toString('base64url');
const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
const grant = `${header}.${body}.${sign('sha256', Buffer.from(`${header}.${body}`), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
const session = randomUUID();
const operation = { id: randomUUID(), actorId: actor, organizationId: org, deviceId: device, sessionId: session,
  sequence: '1', sessionSequence: '1', previousHash: null, kind: 'cash-session-open', grant, configVersion: '1',
  occurredAt: '2023-11-14T22:14:00.000Z', receivedAt: null,
  payload: { id: session, actorUserId: actor, branchId: branch, cashRegisterId: register, openingCash: '0.00',
    currency: 'ARS', openedAt: '2023-11-14T22:14:00.000Z', status: 'OPEN' } } as const;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('base64');
function seal(value: unknown, internalRouting?: unknown): string {
  const routing = { version: 1, keyId: 'rsa', operationId: operation.id, certificate };
  const payloadHash = sha(Buffer.from(canonicalEnvelopeJson(value)));
  const signature = sign('sha256', Buffer.from(payloadHash, 'base64'), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  const cek = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(Buffer.from(canonicalEnvelopeJson(routing)));
  const encrypted = Buffer.concat([cipher.update(canonicalEnvelopeJson({ routing: internalRouting ?? routing, operation: value, payloadHash, signature })), cipher.final(), cipher.getAuthTag()]);
  const unsigned = { ...routing, iv: iv.toString('base64'), wrappedCek: publicEncrypt({ key: rsa.publicKey, oaepHash: 'sha256' }, cek).toString('base64'),
    ciphertext: encrypted.toString('base64'), ciphertextHash: sha(encrypted) };
  return canonicalEnvelopeJson({ ...unsigned, signature: sign('sha256', Buffer.from(canonicalEnvelopeJson(unsigned)),
    { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') });
}
const validator = new HistoricalEnvelopeValidator(certificates, custody);
const history = { grantJws: grant, signingKeyId: 'trusted', signingPublicKey: pem, devicePublicKey: pem,
  organizationId: org, deviceId: device, actorUserId: actor, branchId: branch, epoch: '1', configurationVersion: '1',
  bootstrapHash: claims.bootstrapHash, currency: 'ARS', cashRegisterIds: [register],
  knowledge: { deviceSequence: null, actorSequence: null } };

describe('T200A historical envelope authentication without business effects', () => {
  it('accepts an expired-at-delivery grant only for its original historical scope', async () => {
    const opened = await validator.open(seal(operation), pem);
    expect(validator.validate(opened, history).operation.id).toBe(operation.id);
  });
  it('denies tampering, duplicated routing mismatch and unknown versions', async () => {
    const envelope = JSON.parse(seal(operation)); envelope.ciphertextHash = sha(randomBytes(32));
    await expect(validator.open(JSON.stringify(envelope), pem)).rejects.toThrow('OFFLINE_ENVELOPE_INVALID');
    await expect(validator.open(seal(operation, { version: 1, keyId: 'rsa', operationId: randomUUID(), certificate }), pem)).rejects.toThrow('OFFLINE_ENVELOPE_INVALID');
    envelope.version = 2;
    await expect(validator.open(JSON.stringify(envelope), pem)).rejects.toThrow('OFFLINE_ENVELOPE_INVALID');
  });
  it('rejects changed identity/configuration/grant and out-of-window creation', async () => {
    const opened = await validator.open(seal(operation), pem);
    for (const changed of [{ organizationId: randomUUID() }, { actorUserId: randomUUID() }, { deviceId: randomUUID() },
      { configurationVersion: '2' }, { bootstrapHash: 'b'.repeat(64) }, { grantJws: `${grant}x` }]) {
      expect(() => validator.validate(opened, { ...history, ...changed })).toThrow('OFFLINE_HISTORY_INVALID');
    }
    const late = { ...operation, occurredAt: new Date(claims.exp * 1000).toISOString(),
      payload: { ...operation.payload, openedAt: new Date(claims.exp * 1000).toISOString() } };
    const lateEnvelope=await validator.open(seal(late),pem);
    expect(() => validator.validate(lateEnvelope,history)).toThrow('OFFLINE_HISTORY_INVALID');
  });
  it('rejects post-knowledge sequences even with backdated timestamps', async () => {
    const opened = await validator.open(seal(operation), pem);
    for (const knowledge of [{ deviceSequence: '0', actorSequence: null }, { actorSequence: '0', deviceSequence: null }]) {
      expect(() => validator.validate(opened, { ...history, knowledge })).toThrow('OFFLINE_HISTORY_INVALID');
    }
    expect(validator.validate(opened, { ...history, knowledge: { deviceSequence: '1', actorSequence: '1' } }).operation.id).toBe(operation.id);
  });
  it('does not authorize a payload changed after envelope authentication', async () => {
    const opened=await validator.open(seal(operation),pem);
    expect(()=>validator.validate({...opened,operation:{...opened.operation,payload:{...operation.payload,openingCash:'11.00'}}},history))
      .toThrow('OFFLINE_HISTORY_INVALID');
  });
  it('rejects reusable credentials and malformed business payloads', async () => {
    for (const payload of [{ ...operation.payload, token: 'secret' }, { ...operation.payload, openingCash: '1.234' }]) {
      await expect(validator.open(seal({ ...operation, payload }), pem)).rejects.toThrow('OFFLINE_ENVELOPE_INVALID');
    }
  });
  it('keeps missing retained custody keys recoverable instead of security-rejecting legitimate bytes', async () => {
    const unavailable = new RsaSyncEnvelopeDecryptor({activeKeyId:'rotated',keys:{
      rotated:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString(),
    }},ec.privateKey,'trusted');
    await expect(new HistoricalEnvelopeValidator(certificates,unavailable).open(seal(operation),pem)).rejects.toThrow('temporarily unavailable');
  });
  it('accepts a canonical sealed sale and rejects malformed or fractional UNIT quantities', async () => {
    const hash=sha(Buffer.from('test-request'));
    const line = {itemId:randomUUID(),itemName:'Producto',sku:null,barcode:null,type:'PRODUCT',baseUnit:'UNIT',trackInventory:false,
      quantity:'1',unitPrice:'10.00',priceVersion:1,lineTotal:'10.00'};
    const payload = {id:operation.id,localReference:'LOCAL-1',reference:null,status:'CONFIRMED',requestHash:hash,actorUserId:actor,
      deviceId:device,organizationId:org,branchId:branch,cashSessionId:session,customerId:null,customerKind:'CONSUMER_FINAL',
      configurationVersion:'1',occurredAt:operation.occurredAt,receivedAt:null,
      quote:{currency:'ARS',lines:[line],subtotal:'10.00',discount:'0.00',total:'10.00',discountEvidence:null},
      payments:[{method:'CASH',appliedAmount:'10.00',receivedAmount:'15.00',changeAmount:'5.00'}],
      audit:{action:'sale.confirmed.offline',actorUserId:actor,grantId},receipt:{label:'Comprobante no fiscal',branchName:'Main'},
      result:{id:operation.id,operationId:operation.id,localReference:'LOCAL-1',total:'10.00',change:'5.00'}};
    const sale={...operation,kind:'sale-confirm',sequence:'2',sessionSequence:'2',previousHash:hash,payload};
    expect(validator.validate(await validator.open(seal(sale),pem),history).operation.id).toBe(operation.id);
    for (const quantity of ['banana','0.000','1.0000','01.000','0.500']) {
      expect(await validator.open(seal({...sale,payload:{...payload,quote:{...payload.quote,lines:[{...line,quantity}]}}}),pem)
        .then(()=>false,error=>error instanceof Error && error.message==='OFFLINE_ENVELOPE_INVALID')).toBe(true);
    }
  });
});
