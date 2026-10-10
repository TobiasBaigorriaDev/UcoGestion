import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { z } from 'zod';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

interface InvitationResendOptions {
  readonly now?: () => Date;
}

interface ResendableInvitation {
  readonly email: string;
  readonly role: string;
  readonly status: string;
}

export type InvitationResendErrorCode =
  | 'INVITATION_NOT_RESENDABLE'
  | 'INVITATION_RESEND_FORBIDDEN';

export class InvitationResendError extends Error {
  constructor(
    readonly code: InvitationResendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InvitationResendError';
  }
}

export class InvitationResendService {
  private readonly now: () => Date;

  constructor(
    private readonly transactions: TenantTransaction,
    options: InvitationResendOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async resend(
    context: TenantTransactionContext,
    invitationId: string,
    idempotencyKey?: string,
  ): Promise<{ readonly expiresAt: string; readonly invitationId: string }> {
    const resentAt = this.now();
    const expiresAt = new Date(resentAt.getTime() + invitationLifetimeMs);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const operationId = randomUUID();

    const auditEvent = {
        action: 'invitation.resent',
        after: { status: 'PENDING' },
        afterAllowlist: ['status'],
        before: {},
        beforeAllowlist: [],
        branchId: null,
        context: {},
        contextAllowlist: [],
        entityId: invitationId,
        entityType: 'invitation',
        operationId,
      };
    const operation = async (client: PoolClient) => {
        await this.requireAuthorizedInvitation(client, context, invitationId);
        const invitation = await client.query<ResendableInvitation>(
          `SELECT email_normalized AS email, role, status
           FROM invitations
           WHERE organization_id = $1 AND id = $2
           FOR UPDATE`,
          [context.organizationId, invitationId],
        );
        const row = invitation.rows.at(0);
        if (!row || (row.status !== 'PENDING' && row.status !== 'EXPIRED')) {
          throw new InvitationResendError(
            'INVITATION_NOT_RESENDABLE',
            'La invitación no está disponible para reenvío.',
          );
        }

        const branches = await client.query<{ branchId: string }>(
          `SELECT branch_id AS "branchId"
           FROM invitation_branches
           WHERE organization_id = $1 AND invitation_id = $2
           ORDER BY branch_id`,
          [context.organizationId, invitationId],
        );
        const branchIds = branches.rows.map(({ branchId }) => branchId);

        const updated = await client.query(
          `UPDATE invitations
           SET status = 'PENDING', token_hash = $1, expires_at = $2
           WHERE organization_id = $3
             AND id = $4
             AND status IN ('PENDING', 'EXPIRED')`,
          [tokenHash, expiresAt, context.organizationId, invitationId],
        );
        if (updated.rowCount !== 1) {
          throw new InvitationResendError(
            'INVITATION_NOT_RESENDABLE',
            'La invitación no está disponible para reenvío.',
          );
        }

        await client.query(
          `INSERT INTO outbox_jobs (
             id, organization_id, job_key, job_type, payload, actor_user_id,
             branch_id, authorization_class, available_at, created_at
           ) VALUES ($1, $2, $3, 'INVITATION_EMAIL', $4::jsonb, $5, NULL, 'MEMBERSHIP_ADMINISTRATION', $6, $6)`,
          [
            randomUUID(),
            context.organizationId,
            `invitation-email:${invitationId}:resend:${operationId}`,
            JSON.stringify({ branchIds, email: row.email, invitationId, role: row.role, token }),
            context.userId,
            resentAt,
          ],
        );
        await client.query(
          `INSERT INTO outbox_jobs (
             id, organization_id, job_key, job_type, payload, actor_user_id,
             branch_id, authorization_class, available_at, created_at
           ) VALUES ($1, $2, $3, 'INVITATION_EXPIRATION', $4::jsonb, $5, NULL, 'MEMBERSHIP_ADMINISTRATION', $6, $7)`,
          [
            randomUUID(),
            context.organizationId,
            `invitation-expiration:${invitationId}:${expiresAt.toISOString()}`,
            JSON.stringify({ expiresAt: expiresAt.toISOString(), invitationId }),
            context.userId,
            expiresAt,
            resentAt,
          ],
        );

        return { expiresAt: expiresAt.toISOString(), invitationId };
      };
    if (idempotencyKey) return this.transactions.runIdempotent(context, auditEvent, {
      actorUserId: context.userId, authorizationClass: 'MEMBERSHIP_ADMINISTRATION', branchId: null,
      key: idempotencyKey, organizationId: context.organizationId,
      payload: { invitationId }, scope: 'invitation.resend',
    }, async (client) => { await this.requireAuthorizedInvitation(client, context, invitationId); }, operation,
    (body) => z.object({ invitationId: z.string(), expiresAt: z.string() }).parse(body));
    return this.transactions.run(context, auditEvent, operation);
  }

  private async requireAuthorizedInvitation(client: PoolClient, context: TenantTransactionContext, invitationId: string): Promise<void> {
    const actor = await this.requireManager(client, context);
    const invitation = await client.query<{ role: string }>(
      'SELECT role FROM invitations WHERE organization_id=$1 AND id=$2 FOR UPDATE',
      [context.organizationId, invitationId]);
    if (!invitation.rows[0]) throw new InvitationResendError('INVITATION_NOT_RESENDABLE', 'La invitación no está disponible para reenvío.');
    if (actor.role === 'OWNER') return;
    const scope = await client.query<{ allowed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM invitation_branches WHERE organization_id=$1 AND invitation_id=$2)
        AND NOT EXISTS (
          SELECT 1 FROM invitation_branches ib WHERE ib.organization_id=$1 AND ib.invitation_id=$2
            AND NOT EXISTS (SELECT 1 FROM effective_membership_branch_scope s
              WHERE s.organization_id=ib.organization_id AND s.branch_id=ib.branch_id AND s.membership_id=$3)
        ) AS allowed`, [context.organizationId, invitationId, actor.id]);
    if (invitation.rows[0].role === 'OWNER' || !scope.rows[0]?.allowed) {
      throw new InvitationResendError('INVITATION_RESEND_FORBIDDEN', 'La invitación está fuera de tu alcance.');
    }
  }

  private async requireManager(
    client: PoolClient,
    context: TenantTransactionContext,
  ): Promise<{ id: string; role: string }> {
    const membership = await client.query<{ id: string; role: string }>(
      `SELECT id, role
       FROM memberships
       WHERE organization_id = $1
         AND user_id = $2
         AND status = 'ACTIVE'
         AND revoked_at IS NULL`,
      [context.organizationId, context.userId],
    );
    const actor = membership.rows.at(0);
    if (!actor || (actor.role !== 'OWNER' && actor.role !== 'ADMIN')) {
      throw new InvitationResendError(
        'INVITATION_RESEND_FORBIDDEN',
        'Solo OWNER o ADMIN pueden reenviar invitaciones.',
      );
    }
    return actor;
  }
}
