import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

import { offlineBootstrapPayloadSchema, offlineGrantClaimsSchema, offlineGrantProofPayload,
  offlineGrantProofSchema, type OfflineGrantProof } from '@uconext/shared';
import { z } from 'zod';

import { TenantTransaction, type TenantTransactionContext, type TenantAuditEvent } from '../../database/tenant-transaction.js';
import { authorizeOfflinePos } from './offline-bootstrap.service.js';

const resultSchema = z.strictObject({ grant: z.string().min(1) });
export class OfflineGrantError extends Error {
  constructor(readonly code: 'OFFLINE_SYNC_INCOMPLETE' | 'OFFLINE_GRANT_FORBIDDEN' | 'OFFLINE_GRANT_CONFLICT', message: string) { super(message); }
}

export class OfflineGrantService {
  constructor(private readonly transactions: TenantTransaction, private readonly signingKey: KeyObject, private readonly keyId: string) {
    if (signingKey.type !== 'private' || signingKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('Offline grant signer requires ECDSA P-256.');
    }
  }

  async issue(context: TenantTransactionContext, input: OfflineGrantProof, key: string): Promise<{ grant: string }> {
    const request = offlineGrantProofSchema.parse(input);
    const audit: TenantAuditEvent = {
      action: 'offline.grant_issued', entityType: 'offline_grant', entityId: request.grantId, operationId: request.grantId,
      branchId: null, before: {}, after: {}, context: {}, beforeAllowlist: [], afterAllowlist: [], contextAllowlist: [],
    };
    return this.transactions.runIdempotent(context, audit, { actorUserId: context.userId, organizationId: context.organizationId, authorizationClass: 'OFFLINE_GRANT',
      branchId: null, scope: 'offline.grant', key, payload: { ...request } }, async (client) => {
      const grant = (await client.query<{ device_id: string; branch_id: string; grant_jws: string | null }>(`SELECT g.device_id, d.branch_id, a.grant_jws FROM offline_grants g
        JOIN devices d ON d.organization_id = g.organization_id AND d.id = g.device_id
        LEFT JOIN offline_grant_authorizations a ON a.organization_id = g.organization_id AND a.grant_id = g.id
        WHERE g.organization_id = $1 AND g.id = $2`, [context.organizationId, request.grantId])).rows[0];
      if (!grant) throw new OfflineGrantError('OFFLINE_GRANT_FORBIDDEN', 'Credencial no disponible.');
      const actor = await authorizeOfflinePos(client, context, { deviceId: grant.device_id, branchId: grant.branch_id });
      audit.branchId = grant.branch_id;
      audit.deviceId = grant.device_id;
      if (grant.grant_jws) {
        const claims = offlineGrantClaimsSchema.parse(JSON.parse(Buffer.from(grant.grant_jws.split('.')[1] ?? '', 'base64url').toString()));
        if (claims.role !== actor.role) throw new OfflineGrantError('OFFLINE_GRANT_FORBIDDEN', 'Actualizá permisos y configuración.');
      }
    }, async (client) => {
      const persisted = (await client.query<{ payload: string }>(`SELECT response_body->>'payload' AS payload
        FROM idempotency_records WHERE organization_id = $1 AND actor_user_id = $2 AND scope = 'offline.bootstrap'
        AND status = 'COMPLETED' AND (response_body->>'payload')::jsonb->>'grantId' = $3`,
      [context.organizationId, context.userId, request.grantId])).rows[0];
      if (!persisted || createHash('sha256').update(persisted.payload).digest('hex') !== request.bootstrapHash) {
        throw new OfflineGrantError('OFFLINE_GRANT_FORBIDDEN', 'Bootstrap no verificado.');
      }
      const bootstrap = offlineBootstrapPayloadSchema.parse(JSON.parse(persisted.payload));
      const actor = await authorizeOfflinePos(client, context, bootstrap);
      if (actor.role !== bootstrap.role || bootstrap.ackKey.keyId !== this.keyId ||
        bootstrap.ackKey.publicKeyPem !== createPublicKey(this.signingKey).export({ type: 'spki', format: 'pem' }).toString()) {
        throw new OfflineGrantError('OFFLINE_GRANT_FORBIDDEN', 'Actualizá permisos y configuración.');
      }
      const device = (await client.query<{ public_key: string; public_key_thumbprint: string }>(
        'SELECT public_key, public_key_thumbprint FROM devices WHERE organization_id = $1 AND id = $2',
        [context.organizationId, bootstrap.deviceId],
      )).rows[0];
      const proofPayload = offlineGrantProofPayload(request);
      if (!device || device.public_key_thumbprint !== createHash('sha256').update(createPublicKey(device.public_key)
        .export({ type: 'spki', format: 'der' })).digest('base64url') || !verify('sha256', Buffer.from(proofPayload),
        { key: device.public_key, dsaEncoding: 'ieee-p1363' }, Buffer.from(request.proof, 'base64'))) {
        throw new OfflineGrantError('OFFLINE_GRANT_FORBIDDEN', 'Prueba de dispositivo inválida.');
      }
      const proofHash = createHash('sha256').update(proofPayload).digest('hex');
      const previous = (await client.query<{ actor_user_id: string; proof_hash: string; grant_jws: string }>(
        'SELECT actor_user_id, proof_hash, grant_jws FROM offline_grant_authorizations WHERE organization_id = $1 AND grant_id = $2',
        [context.organizationId, request.grantId],
      )).rows[0];
      if (previous) {
        if (previous.actor_user_id !== context.userId || previous.proof_hash !== proofHash) {
          throw new OfflineGrantError('OFFLINE_GRANT_CONFLICT', 'El grant ya se confirmó con otro checkpoint.');
        }
        return { grant: previous.grant_jws };
      }
      const reservation = await client.query(`SELECT g.id FROM offline_grants g JOIN organizations o ON o.id = g.organization_id
        WHERE g.organization_id = $1 AND g.id = $2 AND g.closed_at IS NULL AND g.revoked_at IS NULL
        AND g.expires_at > now() AND g.epoch = o.config_epoch AND NOT EXISTS (
          SELECT 1 FROM configuration_barriers WHERE organization_id = $1 AND status = 'ACTIVE') FOR UPDATE OF g`,
        [context.organizationId, request.grantId]);
      if (!reservation.rowCount) throw new OfflineGrantError('OFFLINE_GRANT_FORBIDDEN', 'Autorización anterior cerrada o vencida.');
      if (actor.role !== bootstrap.role) throw new OfflineGrantError('OFFLINE_GRANT_FORBIDDEN', 'Actualizá permisos y configuración.');
      const operations = await client.query<{ sequence: string; operation_hash: string; status: string }>(
        'SELECT sequence::text, operation_hash, status FROM sync_operations WHERE organization_id = $1 AND device_id = $2 ORDER BY sequence',
        [context.organizationId, bootstrap.deviceId]);
      let sequence = 0n;
      let headHash: string | null = null;
      for (const row of operations.rows) {
        sequence += 1n;
        if (row.sequence !== sequence.toString() || row.status !== 'ACKED') {
          throw new OfflineGrantError('OFFLINE_SYNC_INCOMPLETE', 'La sincronización está incompleta.');
        }
        headHash = row.operation_hash;
      }
      if (request.deviceSequence !== sequence.toString() || request.headHash !== headHash) {
        throw new OfflineGrantError('OFFLINE_SYNC_INCOMPLETE', 'El checkpoint no coincide con el servidor.');
      }
      const time = (await client.query<{ iat: number }>('SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS iat')).rows[0]?.iat;
      if (time === undefined) throw new Error('Server time unavailable.');
      const claims = offlineGrantClaimsSchema.parse({ version: 1, grantId: request.grantId, organizationId: context.organizationId,
        actorUserId: context.userId, deviceId: bootstrap.deviceId, branchId: bootstrap.branchId, epoch: bootstrap.epoch,
        configurationVersion: bootstrap.configurationVersion, cashRegisterIds: bootstrap.configuration.cashRegisters.map(row => row.id),
        role: actor.role, permissions: bootstrap.permissions, thumbprint: device.public_key_thumbprint,
        bootstrapHash: request.bootstrapHash, iat: time, exp: time + 72 * 60 * 60 });
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: this.keyId, typ: 'uco-offline-grant+jwt' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: this.signingKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      const grant = `${header}.${body}.${signature}`;
      await client.query('UPDATE offline_grants SET expires_at = to_timestamp($3) WHERE organization_id = $1 AND id = $2',
        [context.organizationId, request.grantId, claims.exp]);
      await client.query(`INSERT INTO offline_grant_authorizations
        (organization_id, grant_id, actor_user_id, branch_id, proof_hash, grant_jws, issued_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), to_timestamp($8))`, [context.organizationId, request.grantId,
        context.userId, bootstrap.branchId, proofHash, grant, claims.iat, claims.exp]);
      return { grant };
    }, body => resultSchema.parse(body));
  }
}
