import { createHash, verify } from 'node:crypto';

import { offlineBootstrapPayloadSchema, offlineGrantClaimsSchema } from '@uconext/shared';
import type { PoolClient } from 'pg';

import type { HistoricalEnvelopeContext } from './historical-envelope-validator.js';

interface HistoricalRequest {
  readonly organizationId: string; readonly deviceId: string; readonly actorUserId: string; readonly grantJws: string;
}
interface HistoryRow {
  grant_jws: string; actor_user_id: string; branch_id: string; epoch: string; configuration_version: string;
  public_key: string; public_key_thumbprint: string; bootstrap: string; canonical_payload: string;
  signature: string; signing_key_id: string; public_key_pem: string;
}

/** Internal reader. The caller has authenticated the certificate and obtains knowledge
 * from the server checkpoint resolver, never from DTOs. Current status deliberately
 * does not erase historical authorization. All reads use the contextual transaction. */
export async function readHistoricalEnvelopeContext(client: PoolClient, input: HistoricalRequest,
  knowledge: HistoricalEnvelopeContext['knowledge']): Promise<HistoricalEnvelopeContext> {
  try {
    const claims = offlineGrantClaimsSchema.parse(JSON.parse(Buffer.from(input.grantJws.split('.')[1] ?? '', 'base64url').toString()));
    if (claims.organizationId !== input.organizationId || claims.deviceId !== input.deviceId || claims.actorUserId !== input.actorUserId) throw new Error();
    const row = (await client.query<HistoryRow>(`SELECT a.grant_jws, a.actor_user_id, a.branch_id,
      g.epoch::text, g.configuration_version::text, d.public_key, d.public_key_thumbprint,
      v.canonical_payload, v.signature, v.signing_key_id, v.public_key_pem,
      i.response_body->>'payload' AS bootstrap
      FROM offline_grant_authorizations a
      JOIN offline_grants g ON g.organization_id = a.organization_id AND g.id = a.grant_id
      JOIN devices d ON d.organization_id = g.organization_id AND d.id = g.device_id
      JOIN configuration_versions v ON v.organization_id = g.organization_id AND v.version = g.configuration_version
      JOIN idempotency_records i ON i.organization_id = a.organization_id AND i.actor_user_id = a.actor_user_id
        AND i.scope = 'offline.bootstrap' AND i.status = 'COMPLETED'
        AND (i.response_body->>'payload')::jsonb->>'grantId' = a.grant_id::text
      WHERE a.organization_id = $1 AND a.grant_id = $2 AND a.actor_user_id = $3 AND g.device_id = $4`,
    [input.organizationId, claims.grantId, input.actorUserId, input.deviceId])).rows[0];
    if (!row || row.grant_jws !== input.grantJws || row.actor_user_id !== claims.actorUserId ||
      row.branch_id !== claims.branchId || row.epoch !== claims.epoch || row.configuration_version !== claims.configurationVersion ||
      row.public_key_thumbprint !== claims.thumbprint || createHash('sha256').update(row.bootstrap).digest('hex') !== claims.bootstrapHash ||
      !verify('sha256', Buffer.from(row.canonical_payload), row.public_key_pem, Buffer.from(row.signature, 'base64'))) throw new Error();
    const bootstrap = offlineBootstrapPayloadSchema.parse(JSON.parse(row.bootstrap));
    if (bootstrap.organizationId !== input.organizationId || bootstrap.actorUserId !== input.actorUserId || bootstrap.deviceId !== input.deviceId ||
      bootstrap.grantId !== claims.grantId || bootstrap.branchId !== row.branch_id || bootstrap.epoch !== row.epoch ||
      bootstrap.configurationVersion !== row.configuration_version || bootstrap.ackKey.publicKeyPem !== row.public_key_pem ||
      bootstrap.ackKey.keyId !== row.signing_key_id) throw new Error();
    return { ...input, signingKeyId: bootstrap.ackKey.keyId, signingPublicKey: bootstrap.ackKey.publicKeyPem,
      devicePublicKey: row.public_key, branchId: row.branch_id, epoch: row.epoch, configurationVersion: row.configuration_version,
      bootstrapHash: claims.bootstrapHash, currency: bootstrap.configuration.currency,
      cashRegisterIds: bootstrap.configuration.cashRegisters.map(register => register.id), knowledge };
  } catch { throw new Error('OFFLINE_HISTORY_INVALID'); }
}
