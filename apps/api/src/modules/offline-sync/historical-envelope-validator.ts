import { createDecipheriv, createHash, verify } from 'node:crypto';

import { offlineConfirmedSaleSchema, offlineGrantClaimsSchema } from '@uconext/shared';
import { z } from 'zod';

import { DeviceCertificate, type DeviceCertificateClaims } from './device-certificate.js';
import { IngestionKeyUnavailableError, type SyncEnvelopeDecryptorPort } from './sync-envelope-decryptor.js';

const counter = z.string().regex(/^[1-9]\d{0,18}$/);
const digest = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const utc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const routingSchema = z.strictObject({ version: z.literal(1), keyId: z.string().min(1).max(128), operationId: z.uuid(), certificate: z.string().min(1).max(2048) });
const base64 = z.string().min(1).refine(value => Buffer.from(value, 'base64').toString('base64') === value);
const outerSchema = routingSchema.extend({ iv: base64, wrappedCek: base64, ciphertext: base64, ciphertextHash: digest, signature: base64 });
const operationSchema = z.strictObject({ id: z.uuid(), actorId: z.uuid(), organizationId: z.uuid(), deviceId: z.uuid(), sessionId: z.uuid(),
  sequence: counter, sessionSequence: counter, previousHash: digest.nullable(), kind: z.enum(['cash-session-open', 'sale-confirm']),
  payload: z.unknown(), grant: z.string().min(1).max(8192), configVersion: counter, occurredAt: utc, receivedAt: z.null() });
const openingSchema = z.strictObject({ id: z.uuid(), actorUserId: z.uuid(), branchId: z.uuid(), cashRegisterId: z.uuid(),
  openingCash: z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/), currency: z.string().regex(/^[A-Z]{3}$/), openedAt: utc, status: z.literal('OPEN') });
const innerSchema = z.strictObject({ routing: routingSchema, operation: operationSchema, payloadHash: digest, signature: base64 });

export function assertEnvelopeTransportRouting(exactEnvelope: string, certificate: string): void {
  try {
    if (Buffer.byteLength(exactEnvelope)>2*1024*1024) throw new Error();
    const envelope = outerSchema.parse(JSON.parse(exactEnvelope));
    if (envelope.certificate !== certificate || Buffer.from(envelope.iv,'base64').length !== 12 ||
      Buffer.from(envelope.wrappedCek,'base64').length !== 384 || Buffer.from(envelope.signature,'base64').length !== 64 ||
      Buffer.from(envelope.ciphertext,'base64').length < 17 || hash(Buffer.from(envelope.ciphertext,'base64')) !== envelope.ciphertextHash) throw new Error();
  } catch { throw new Error('OFFLINE_ENVELOPE_INVALID'); }
}

export function canonicalEnvelopeJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEnvelopeJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalEnvelopeJson(Reflect.get(value, key))}`).join(',')}}`;
  }
  throw new Error('OFFLINE_ENVELOPE_INVALID');
}
const hash = (value: Buffer) => createHash('sha256').update(value).digest('base64');
function signatureIsValid(data: Buffer, signature: string, publicKey: string): boolean {
  const bytes = Buffer.from(signature, 'base64');
  return bytes.length === 64 && verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, bytes);
}
function rejectCredentials(value: unknown): void {
  if (typeof value === 'string' && /^Bearer\s/i.test(value)) throw new Error('OFFLINE_ENVELOPE_INVALID');
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(password|sessiontoken|onlinesession|authorization|bearer|token|accesstoken|refreshtoken|cookie|csrftoken)$/i.test(key.replace(/[_-]/g, ''))) {
      throw new Error('OFFLINE_ENVELOPE_INVALID');
    }
    rejectCredentials(nested);
  }
}

/** All facts come from server persistence under the certificate's tenant, never the HTTP caller.
 * The knowledge cutoffs are inclusive last-legitimate device sequences. Their durable
 * collection belongs to T204; no current-status check can substitute for this evidence. */
export interface HistoricalEnvelopeContext {
  readonly grantJws: string; readonly signingKeyId: string; readonly signingPublicKey: string;
  readonly devicePublicKey: string; readonly organizationId: string; readonly deviceId: string;
  readonly actorUserId: string; readonly branchId: string; readonly epoch: string;
  readonly configurationVersion: string; readonly bootstrapHash: string; readonly currency: string;
  readonly cashRegisterIds: readonly string[];
  readonly knowledge: { readonly deviceSequence: string | null; readonly actorSequence: string | null };
}
export interface OpenedHistoricalEnvelope {
  readonly operation: z.infer<typeof operationSchema>; readonly certificate: DeviceCertificateClaims;
  readonly operationHash: string; readonly envelopeHash: string;
}

/** Internal validation only: no business writes, ACK, session authentication or membership activation. */
export class HistoricalEnvelopeValidator {
  constructor(private readonly certificates: DeviceCertificate, private readonly decryptor: SyncEnvelopeDecryptorPort) {}

  async open(exactEnvelope: string, devicePublicKey: string): Promise<OpenedHistoricalEnvelope> {
    // Check bounded routing and the registered-key signature before private-key work.
    let outer: z.infer<typeof outerSchema>;
    let certificate: DeviceCertificateClaims;
    try {
      if (Buffer.byteLength(exactEnvelope) > 2 * 1024 * 1024) throw new Error();
      outer = outerSchema.parse(JSON.parse(exactEnvelope));
      const { signature, ...unsigned } = outer;
      certificate = this.certificates.open(outer.certificate);
      if (this.certificates.thumbprint(devicePublicKey) !== certificate.thumbprint ||
        !signatureIsValid(Buffer.from(canonicalEnvelopeJson(unsigned)), signature, devicePublicKey) ||
        Buffer.from(outer.iv, 'base64').length !== 12 || Buffer.from(outer.wrappedCek, 'base64').length !== 384 ||
        hash(Buffer.from(outer.ciphertext, 'base64')) !== outer.ciphertextHash) throw new Error();
    } catch { throw new Error('OFFLINE_ENVELOPE_INVALID'); }
    // Missing retained custody keys remain recoverable: never turn them into security rejection.
    let cek: Uint8Array;
    try { cek = await this.decryptor.unwrap(outer.keyId, Buffer.from(outer.wrappedCek, 'base64')); }
    catch (error) {
      if (error instanceof IngestionKeyUnavailableError) throw error;
      throw new Error('OFFLINE_ENVELOPE_INVALID',{cause:error});
    }
    try {
      const { version, keyId, operationId, certificate: token } = outer;
      const routing = { version, keyId, operationId, certificate: token };
      const encrypted = Buffer.from(outer.ciphertext, 'base64');
      if (cek.length !== 32 || encrypted.length < 17) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', cek, Buffer.from(outer.iv, 'base64'));
      cipher.setAAD(Buffer.from(canonicalEnvelopeJson(routing))); cipher.setAuthTag(encrypted.subarray(-16));
      const plaintext = Buffer.concat([cipher.update(encrypted.subarray(0, -16)), cipher.final()]).toString('utf8');
      const inner = innerSchema.parse(JSON.parse(plaintext));
      if (plaintext !== canonicalEnvelopeJson(inner) || canonicalEnvelopeJson(inner.routing) !== canonicalEnvelopeJson(routing) ||
        inner.operation.id !== outer.operationId || inner.operation.organizationId !== certificate.organizationId ||
        inner.operation.deviceId !== certificate.deviceId || hash(Buffer.from(canonicalEnvelopeJson(inner.operation))) !== inner.payloadHash ||
        !signatureIsValid(Buffer.from(inner.payloadHash, 'base64'), inner.signature, devicePublicKey)) throw new Error();
      rejectCredentials(inner.operation);
      if (inner.operation.kind === 'cash-session-open') openingSchema.parse(inner.operation.payload);
      else offlineConfirmedSaleSchema.parse(inner.operation.payload);
      return { operation: inner.operation, certificate, operationHash: inner.payloadHash,
        envelopeHash: createHash('sha256').update(exactEnvelope).digest('hex') };
    } catch { throw new Error('OFFLINE_ENVELOPE_INVALID'); }
    finally { cek.fill(0); }
  }

  validate(envelope: OpenedHistoricalEnvelope, history: HistoricalEnvelopeContext) {
    try {
      const operation = operationSchema.parse(envelope.operation);
      if (hash(Buffer.from(canonicalEnvelopeJson(operation))) !== envelope.operationHash) throw new Error();
      const parts = operation.grant.split('.');
      if (parts.length !== 3 || operation.grant !== history.grantJws) throw new Error();
      const [header, body, signature] = parts;
      const metadata = z.strictObject({ alg: z.literal('ES256'), kid: z.string(), typ: z.literal('uco-offline-grant+jwt') })
        .parse(JSON.parse(Buffer.from(header ?? '', 'base64url').toString()));
      const claims = offlineGrantClaimsSchema.parse(JSON.parse(Buffer.from(body ?? '', 'base64url').toString()));
      if (metadata.kid !== history.signingKeyId || !signatureIsValid(Buffer.from(`${header}.${body}`),
        Buffer.from(signature ?? '', 'base64url').toString('base64'), history.signingPublicKey)) throw new Error();
      if (operation.organizationId !== history.organizationId || operation.deviceId !== history.deviceId || operation.actorId !== history.actorUserId ||
        claims.organizationId !== history.organizationId || claims.deviceId !== history.deviceId || claims.actorUserId !== history.actorUserId ||
        claims.branchId !== history.branchId || claims.epoch !== history.epoch || claims.configurationVersion !== history.configurationVersion ||
        operation.configVersion !== history.configurationVersion || claims.bootstrapHash !== history.bootstrapHash ||
        claims.thumbprint !== this.certificates.thumbprint(history.devicePublicKey) ||
        envelope.certificate.thumbprint !== claims.thumbprint || envelope.certificate.organizationId !== claims.organizationId ||
        envelope.certificate.deviceId !== claims.deviceId ||
        Date.parse(operation.occurredAt) < claims.iat * 1000 || Date.parse(operation.occurredAt) >= claims.exp * 1000) throw new Error();
      for (const cutoff of [history.knowledge.deviceSequence, history.knowledge.actorSequence]) {
        if (cutoff !== null && (!/^(?:0|[1-9]\d{0,18})$/.test(cutoff) || BigInt(operation.sequence) > BigInt(cutoff))) throw new Error();
      }
      if (operation.kind === 'cash-session-open') {
        const opening = openingSchema.parse(operation.payload);
        if (opening.id !== operation.sessionId || opening.actorUserId !== operation.actorId || opening.branchId !== claims.branchId ||
          opening.currency !== history.currency || opening.openedAt !== operation.occurredAt || operation.sessionSequence !== '1' ||
          !claims.cashRegisterIds.includes(opening.cashRegisterId) || !history.cashRegisterIds.includes(opening.cashRegisterId)) throw new Error();
      } else {
        const sale = offlineConfirmedSaleSchema.parse(operation.payload);
        if (sale.actorUserId !== operation.actorId || sale.organizationId !== operation.organizationId || sale.deviceId !== operation.deviceId ||
          sale.cashSessionId !== operation.sessionId || sale.branchId !== claims.branchId || sale.configurationVersion !== operation.configVersion ||
          sale.occurredAt !== operation.occurredAt || sale.quote.currency !== history.currency || sale.audit.actorUserId !== operation.actorId ||
          sale.audit.grantId !== claims.grantId || sale.result.id !== sale.id || sale.result.operationId !== operation.id || operation.sessionSequence === '1') throw new Error();
        const discount = sale.quote.discountEvidence;
        if (discount && (!claims.permissions.canDiscount || !['OWNER','ADMIN'].includes(claims.role) || discount.actorUserId !== claims.actorUserId ||
          discount.grantId !== claims.grantId || discount.configurationVersion !== claims.configurationVersion || discount.role !== claims.role)) throw new Error();
      }
      return { ...envelope, operation, claims };
    } catch { throw new Error('OFFLINE_HISTORY_INVALID'); }
  }
}
