import { createHash, createHmac, randomUUID, sign, verify, type KeyObject } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { revocationCheckpointSchema,type RevocationCheckpoint } from '@uconext/shared';
import { recordRevocationCheckpoint } from './revocation-checkpoint.js';
import { DeviceCertificate, type DeviceCertificateClaims } from './device-certificate.js';
import { assertEnvelopeTransportRouting } from './historical-envelope-validator.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const challengeSchema = z.strictObject({ certificate: z.string().max(2048) });
const pushSchema = z.strictObject({ certificate: z.string().max(2048), challenge: z.string().max(4096),
  envelopes: z.array(z.string().min(1).max(2*1024*1024)).min(1).max(50), proof: z.string().max(128),checkpoints:z.array(revocationCheckpointSchema).max(100).optional() });
const nonceSchema = z.strictObject({ version: z.literal(1), jti: z.uuid(), certificateHash: z.string().regex(/^[0-9a-f]{64}$/),
  origin: z.string(), iat: z.number().int(), exp: z.number().int() });
const headerSchema = z.strictObject({ alg: z.literal('ES256'), kid: z.string(), typ: z.literal('uco-delivery-challenge+jwt') });

export function deliveryProofPayload(challenge: string, exactEnvelopes: readonly string[], checkpoints?:readonly RevocationCheckpoint[]): string {
  return JSON.stringify({ domain: 'UcoNext:delivery:v1', challenge, batchHash: hash(JSON.stringify(exactEnvelopes)),...(checkpoints ? {checkpointHash:hash(JSON.stringify(checkpoints))}: {}) });
}
export class DeliveryRejectedError extends Error { constructor() { super('OFFLINE_DELIVERY_REJECTED'); } }
export class HistoricalIngestionUnavailableError extends Error {}
export interface HistoricalDeliveryIngestionPort {
  deliver(certificate: DeviceCertificateClaims, envelopes: readonly string[]): Promise<{ readonly acks: readonly string[] }>;
}
export class UnconfiguredHistoricalDeliveryIngestion implements HistoricalDeliveryIngestionPort {
  async deliver(): Promise<{ readonly acks: readonly string[] }> {
    throw new HistoricalIngestionUnavailableError('Historical ingestion is not composed yet.');
  }
}
export interface DeliveryKeys {
  readonly certificates: DeviceCertificate; readonly signingKey: KeyObject; readonly keyId: string; readonly rateLimitPepper: string;
}

/** Device transport has no actor session or ordinary application permissions.
 * T201 composes its per-envelope historical transaction; T202A signs the ACKs. */
export class OfflineDeliveryService {
  constructor(private readonly pool: Pool, private readonly keys: () => DeliveryKeys,
    private readonly origin: () => string, private readonly ingestion: HistoricalDeliveryIngestionPort) {}

  private async consumeLimit(ip: string, certificate: string, keys: DeliveryKeys) {
    for (const [identity, limit] of [['all',60], [hash(certificate),20]] as const) {
      const hmac = (value: string) => createHmac('sha256', keys.rateLimitPepper).update(value).digest('hex');
      const result = await this.pool.query<{ attempts: number }>(`INSERT INTO security_rate_limits
        (scope,identity_hash,ip_hash,window_started_at,attempts,updated_at) VALUES ('OFFLINE_DELIVERY',$1,$2,clock_timestamp(),1,clock_timestamp())
        ON CONFLICT (scope,identity_hash,ip_hash) DO UPDATE SET
        attempts=CASE WHEN security_rate_limits.window_started_at <= clock_timestamp()-interval '60 seconds' THEN 1 ELSE security_rate_limits.attempts+1 END,
        window_started_at=CASE WHEN security_rate_limits.window_started_at <= clock_timestamp()-interval '60 seconds' THEN clock_timestamp() ELSE security_rate_limits.window_started_at END,
        updated_at=clock_timestamp() RETURNING attempts`, [hmac(identity),hmac(ip)]);
      if ((result.rows[0]?.attempts ?? limit+1) > limit) throw new DeliveryRejectedError();
    }
  }

  private async scoped<T>(certificate: DeviceCertificateClaims, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id','',true),set_config('app.request_id',$2,true)",
        [certificate.organizationId,randomUUID()]);
      const result = await operation(client);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async registered(client: PoolClient, certificate: DeviceCertificateClaims, certificates: DeviceCertificate) {
    const device = (await client.query<{ public_key: string; public_key_thumbprint: string }>(
      'SELECT public_key,public_key_thumbprint FROM devices WHERE organization_id=$1 AND id=$2',
      [certificate.organizationId,certificate.deviceId])).rows[0];
    if (!device || device.public_key_thumbprint !== certificate.thumbprint || certificates.thumbprint(device.public_key) !== certificate.thumbprint) throw new DeliveryRejectedError();
    return device.public_key;
  }

  async challenge(input: unknown, ip: string, organizationHeader?: string | string[]) {
    const keys = this.keys();
    const certificateText = typeof input === 'object' && input !== null && 'certificate' in input && typeof input.certificate === 'string' ? input.certificate.slice(0,2048) : '';
    await this.consumeLimit(ip,certificateText,keys);
    try {
      const request = challengeSchema.parse(input);
      const certificate = keys.certificates.open(request.certificate);
      if (organizationHeader !== undefined && organizationHeader !== certificate.organizationId) throw new Error();
      return await this.scoped(certificate, async client => {
        await this.registered(client,certificate,keys.certificates);
        const iat = (await client.query<{ iat: number }>('SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS iat')).rows[0]?.iat;
        if (iat === undefined) throw new Error();
        const claims = { version: 1, jti: randomUUID(), certificateHash: hash(request.certificate), origin: this.origin(), iat, exp: iat+120 };
        const header = Buffer.from(JSON.stringify({ alg:'ES256',kid:keys.keyId,typ:'uco-delivery-challenge+jwt' })).toString('base64url');
        const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
        const signature = sign('sha256',Buffer.from(`${header}.${body}`),{key:keys.signingKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
        await client.query(`INSERT INTO sync_delivery_challenges (organization_id,device_id,jti_hash,certificate_hash,origin,expires_at)
          VALUES ($1,$2,$3,$4,$5,to_timestamp($6))`, [certificate.organizationId,certificate.deviceId,hash(claims.jti),claims.certificateHash,claims.origin,claims.exp]);
        return { challenge:`${header}.${body}.${signature}` };
      });
    } catch { throw new DeliveryRejectedError(); }
  }

  async push(input: unknown, ip: string, organizationHeader?: string | string[]) {
    const keys = this.keys();
    const certificateText = typeof input === 'object' && input !== null && 'certificate' in input && typeof input.certificate === 'string' ? input.certificate.slice(0,2048) : '';
    await this.consumeLimit(ip,certificateText,keys);
    let request: z.infer<typeof pushSchema>, certificate: DeviceCertificateClaims;
    try {
      request = pushSchema.parse(input);
      if (request.envelopes.reduce((total,envelope) => total+Buffer.byteLength(envelope),0) > 4*1024*1024) throw new Error();
      for (const envelope of request.envelopes) assertEnvelopeTransportRouting(envelope,request.certificate);
      certificate = keys.certificates.open(request.certificate);
      if (organizationHeader !== undefined && organizationHeader !== certificate.organizationId) throw new Error();
      const [header,body,signature,...extra] = request.challenge.split('.');
      if (!header || !body || !signature || extra.length) throw new Error();
      const metadata = headerSchema.parse(JSON.parse(Buffer.from(header,'base64url').toString()));
      const claims = nonceSchema.parse(JSON.parse(Buffer.from(body,'base64url').toString()));
      if (metadata.kid !== keys.keyId || claims.origin !== this.origin() || claims.certificateHash !== hash(request.certificate) || claims.exp-claims.iat !== 120 ||
        !verify('sha256',Buffer.from(`${header}.${body}`),{key:keys.signingKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url'))) throw new Error();
      await this.scoped(certificate, async client => {
        const publicKey = await this.registered(client,certificate,keys.certificates);
        const proof = Buffer.from(request.proof,'base64');
        if (proof.length !== 64 || proof.toString('base64') !== request.proof || !verify('sha256',Buffer.from(deliveryProofPayload(request.challenge,request.envelopes,request.checkpoints)),
          {key:publicKey,dsaEncoding:'ieee-p1363'},proof)) throw new Error();
        for (const checkpoint of request.checkpoints ?? []) await recordRevocationCheckpoint(client,certificate,checkpoint);
        const used = await client.query(`UPDATE sync_delivery_challenges SET used_at=clock_timestamp()
          WHERE organization_id=$1 AND device_id=$2 AND jti_hash=$3 AND certificate_hash=$4 AND origin=$5
          AND used_at IS NULL AND expires_at>clock_timestamp() RETURNING jti_hash`,
        [certificate.organizationId,certificate.deviceId,hash(claims.jti),claims.certificateHash,claims.origin]);
        if (!used.rowCount) throw new Error();
      });
    } catch { throw new DeliveryRejectedError(); }
    return this.ingestion.deliver(certificate,request.envelopes);
  }
}
