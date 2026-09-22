import type { PoolClient } from 'pg';

import { AuditEventWriter } from '../../core/audit/audit-event-writer.js';
import type { OutboxJob } from '../../core/outbox/outbox-worker.js';

interface InvitationExpirationPayload {
  readonly expiresAt: string;
  readonly invitationId: string;
}

export async function handleInvitationExpiration(
  job: OutboxJob,
  client: PoolClient,
): Promise<void> {
  const payload = parsePayload(job.payload);
  const expired = await client.query<{ id: string }>(
    `UPDATE invitations
     SET status = 'EXPIRED'
     WHERE organization_id = $1
       AND id = $2
       AND status = 'PENDING'
       AND expires_at = $3::timestamptz
       AND expires_at <= pg_catalog.clock_timestamp()
     RETURNING id`,
    [job.organizationId, payload.invitationId, payload.expiresAt],
  );
  if (expired.rowCount !== 1) {
    return;
  }

  const requestContext = await client.query<{ request_id: string | null }>(
    "SELECT nullif(current_setting('app.request_id', true), '') AS request_id",
  );
  await new AuditEventWriter(client).append({
    action: 'invitation.expired',
    actorUserId: job.actorUserId,
    after: { status: 'EXPIRED' },
    afterAllowlist: ['status'],
    before: { status: 'PENDING' },
    beforeAllowlist: ['status'],
    branchId: null,
    context: { jobId: job.id },
    contextAllowlist: ['jobId'],
    entityId: payload.invitationId,
    entityType: 'invitation',
    operationId: job.id,
    organizationId: job.organizationId,
    requestId: requestContext.rows.at(0)?.request_id ?? `outbox:${job.id}`,
  });
}

function parsePayload(payload: OutboxJob['payload']): InvitationExpirationPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Invalid invitation expiration payload.');
  }
  const { expiresAt, invitationId } = payload;
  if (
    typeof expiresAt !== 'string'
    || Number.isNaN(Date.parse(expiresAt))
    || typeof invitationId !== 'string'
    || invitationId.length === 0
  ) {
    throw new Error('Invalid invitation expiration payload.');
  }
  return { expiresAt, invitationId };
}
