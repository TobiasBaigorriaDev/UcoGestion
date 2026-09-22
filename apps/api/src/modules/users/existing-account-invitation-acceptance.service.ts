import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { AuditEventWriter } from '../../core/audit/audit-event-writer.js';

interface InvitationAcceptanceOptions {
  readonly now?: () => Date;
}

interface ResolvedInvitation {
  readonly expiration_actor_user_id: string;
  readonly invitation_id: string;
  readonly is_expired: boolean;
  readonly organization_id: string;
  readonly user_id: string | null;
}

export interface ExistingAccountInvitationAcceptanceResult {
  readonly membershipId: string;
  readonly organizationId: string;
}

export class InvitationAcceptanceError extends Error {
  readonly code = 'INVITATION_NOT_ACCEPTABLE' as const;

  constructor() {
    super('La invitación no está disponible para aceptación.');
    this.name = 'InvitationAcceptanceError';
  }
}

export class ExistingAccountInvitationAcceptanceService {
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    options: InvitationAcceptanceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async accept(
    token: string,
    requestId: string,
  ): Promise<ExistingAccountInvitationAcceptanceResult> {
    const client = await this.pool.connect();
    let transactionOpen = false;

    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const acceptedAt = this.now();
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const resolved = await this.resolveInvitation(client, tokenHash, acceptedAt);
      if (!resolved) {
        throw new InvitationAcceptanceError();
      }
      if (resolved.is_expired) {
        await this.auditExpiration(client, resolved, requestId);
        await client.query('COMMIT');
        transactionOpen = false;
        throw new InvitationAcceptanceError();
      }
      if (!resolved.user_id) {
        throw new InvitationAcceptanceError();
      }

      await client.query("SELECT set_config('app.organization_id', $1, true)", [resolved.organization_id]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [resolved.user_id]);
      await client.query("SELECT set_config('app.request_id', $1, true)", [requestId]);

      const invitation = await client.query<{ role: string }>(
        `SELECT role
         FROM invitations
         WHERE organization_id = $1
           AND id = $2
           AND token_hash = $3
           AND status = 'PENDING'
           AND revoked_at IS NULL
           AND expires_at > $4
         FOR UPDATE`,
        [resolved.organization_id, resolved.invitation_id, tokenHash, acceptedAt],
      );
      const invitationRow = invitation.rows.at(0);
      if (!invitationRow) {
        throw new InvitationAcceptanceError();
      }

      const existingMembership = await client.query(
        `SELECT id
         FROM memberships
         WHERE organization_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [resolved.organization_id, resolved.user_id],
      );
      if (existingMembership.rowCount !== 0) {
        throw new InvitationAcceptanceError();
      }

      const membershipId = randomUUID();
      await client.query(
        `INSERT INTO memberships (id, organization_id, user_id, role, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [membershipId, resolved.organization_id, resolved.user_id, invitationRow.role, acceptedAt],
      );
      await client.query(
        `INSERT INTO membership_branches (
           organization_id, membership_id, branch_id, created_at
         )
         SELECT organization_id, $1, branch_id, $2
         FROM invitation_branches
         WHERE organization_id = $3 AND invitation_id = $4`,
        [membershipId, acceptedAt, resolved.organization_id, resolved.invitation_id],
      );
      await client.query(
        `UPDATE invitations
         SET status = 'ACCEPTED', accepted_at = $1
         WHERE organization_id = $2 AND id = $3`,
        [acceptedAt, resolved.organization_id, resolved.invitation_id],
      );
      await new AuditEventWriter(client).append({
        action: 'invitation.accepted',
        actorUserId: resolved.user_id,
        after: { membershipId, status: 'ACCEPTED' },
        afterAllowlist: ['membershipId', 'status'],
        before: { status: 'PENDING' },
        beforeAllowlist: ['status'],
        branchId: null,
        context: {},
        contextAllowlist: [],
        entityId: resolved.invitation_id,
        entityType: 'invitation',
        operationId: resolved.invitation_id,
        organizationId: resolved.organization_id,
        requestId,
      });

      await client.query('COMMIT');
      transactionOpen = false;
      return { membershipId, organizationId: resolved.organization_id };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async resolveInvitation(
    client: PoolClient,
    tokenHash: string,
    acceptedAt: Date,
  ): Promise<ResolvedInvitation | undefined> {
    const result = await client.query<ResolvedInvitation>(
      `SELECT organization_id, invitation_id, user_id, expiration_actor_user_id, is_expired
       FROM identity_api.resolve_existing_account_invitation($1, $2)`,
      [tokenHash, acceptedAt],
    );
    return result.rows.at(0);
  }

  private async auditExpiration(
    client: PoolClient,
    resolved: ResolvedInvitation,
    requestId: string,
  ): Promise<void> {
    await client.query("SELECT set_config('app.organization_id', $1, true)", [resolved.organization_id]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [resolved.expiration_actor_user_id]);
    await client.query("SELECT set_config('app.request_id', $1, true)", [requestId]);
    await new AuditEventWriter(client).append({
      action: 'invitation.expired',
      actorUserId: resolved.expiration_actor_user_id,
      after: { status: 'EXPIRED' },
      afterAllowlist: ['status'],
      before: { status: 'PENDING' },
      beforeAllowlist: ['status'],
      branchId: null,
      context: { trigger: 'token_use' },
      contextAllowlist: ['trigger'],
      entityId: resolved.invitation_id,
      entityType: 'invitation',
      operationId: resolved.invitation_id,
      organizationId: resolved.organization_id,
      requestId,
    });
  }
}
