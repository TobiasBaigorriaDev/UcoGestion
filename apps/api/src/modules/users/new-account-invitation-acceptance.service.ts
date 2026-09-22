import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { AuditEventWriter } from '../../core/audit/audit-event-writer.js';
import { hashPassword } from '../auth/password.js';
import { InvitationAcceptanceError } from './existing-account-invitation-acceptance.service.js';

interface NewAccountInvitationAcceptanceOptions {
  readonly now?: () => Date;
}

interface NewAccountInvitationAcceptanceInput {
  readonly password: string;
  readonly token: string;
}

interface ResolvedInvitation {
  readonly invitation_id: string;
  readonly organization_id: string;
}

export interface NewAccountInvitationAcceptanceResult {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly userId: string;
}

export class PasswordPolicyError extends Error {
  readonly code = 'PASSWORD_NOT_SECURE' as const;

  constructor() {
    super('La contraseña debe tener entre 12 y 256 caracteres.');
    this.name = 'PasswordPolicyError';
  }
}

export class NewAccountInvitationAcceptanceService {
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    options: NewAccountInvitationAcceptanceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async accept(
    input: NewAccountInvitationAcceptanceInput,
    requestId: string,
  ): Promise<NewAccountInvitationAcceptanceResult> {
    requireSecurePassword(input.password);
    const password = await hashPassword(input.password);
    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    const acceptedAt = this.now();
    const userId = randomUUID();
    const membershipId = randomUUID();
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const resolved = await this.resolveInvitation(client, tokenHash, acceptedAt);
      if (!resolved) {
        throw new InvitationAcceptanceError();
      }

      await client.query("SELECT set_config('app.organization_id', $1, true)", [resolved.organization_id]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      await client.query("SELECT set_config('app.request_id', $1, true)", [requestId]);

      const invitation = await client.query<{ email_normalized: string; role: string }>(
        `SELECT email_normalized, role
         FROM invitations
         WHERE organization_id = $1
           AND id = $2
           AND token_hash = $3
           AND status = 'PENDING'
           AND revoked_at IS NULL
           AND expires_at > $4
           AND NOT EXISTS (
             SELECT 1 FROM users WHERE users.email_normalized = invitations.email_normalized
           )
         FOR UPDATE`,
        [resolved.organization_id, resolved.invitation_id, tokenHash, acceptedAt],
      );
      const invitationRow = invitation.rows.at(0);
      if (!invitationRow) {
        throw new InvitationAcceptanceError();
      }

      await client.query(
        `INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
         VALUES ($1, $2, $3, $4)`,
        [userId, invitationRow.email_normalized, password.hash, password.version],
      );
      await client.query(
        `INSERT INTO memberships (id, organization_id, user_id, role, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [membershipId, resolved.organization_id, userId, invitationRow.role, acceptedAt],
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
        actorUserId: userId,
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
      return { membershipId, organizationId: resolved.organization_id, userId };
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) {
        throw new InvitationAcceptanceError();
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
      `SELECT organization_id, invitation_id
       FROM identity_api.resolve_new_account_invitation($1, $2)`,
      [tokenHash, acceptedAt],
    );
    return result.rows.at(0);
  }
}

function requireSecurePassword(password: string): void {
  if (password.length < 12 || password.length > 256) {
    throw new PasswordPolicyError();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}
