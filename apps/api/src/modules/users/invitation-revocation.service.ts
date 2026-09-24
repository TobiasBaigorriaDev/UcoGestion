import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { z } from 'zod';

interface InvitationRevocationOptions {
  readonly now?: () => Date;
}

export type InvitationRevocationErrorCode =
  | 'INVITATION_NOT_REVOCABLE'
  | 'INVITATION_REVOCATION_FORBIDDEN';

export class InvitationRevocationError extends Error {
  constructor(
    readonly code: InvitationRevocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InvitationRevocationError';
  }
}

export class InvitationRevocationService {
  private readonly now: () => Date;

  constructor(
    private readonly transactions: TenantTransaction,
    options: InvitationRevocationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async revoke(
    context: TenantTransactionContext,
    invitationId: string,
    idempotencyKey?: string,
  ): Promise<{ readonly invitationId: string; readonly status: 'REVOKED' }> {
    const revokedAt = this.now();
    const auditEvent = {
        action: 'invitation.revoked',
        after: { status: 'REVOKED' },
        afterAllowlist: ['status'],
        before: { status: 'PENDING' },
        beforeAllowlist: ['status'],
        branchId: null,
        context: {},
        contextAllowlist: [],
        entityId: invitationId,
        entityType: 'invitation',
        operationId: invitationId,
      };
    const authorize = async (client: PoolClient) => {
        const manager = await this.requireManager(client, context);
        const invitation = await client.query<{ role: string; status: string }>(
          `SELECT role, status
           FROM invitations
           WHERE organization_id = $1 AND id = $2
           FOR UPDATE`,
          [context.organizationId, invitationId],
        );
        const row = invitation.rows.at(0);
        if (!row) {
          throw new InvitationRevocationError(
            'INVITATION_NOT_REVOCABLE',
            'La invitación no está disponible para revocación.',
          );
        }
        if (manager.role === 'ADMIN') {
          const scope = await client.query<{ allowed: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM invitation_branches ib
               JOIN effective_membership_branch_scope actor_scope
                 ON actor_scope.organization_id = ib.organization_id AND actor_scope.branch_id = ib.branch_id
               WHERE ib.organization_id = $1 AND ib.invitation_id = $2 AND actor_scope.membership_id = $3
             ) AS allowed`,
            [context.organizationId, invitationId, manager.id],
          );
          if (row.role === 'OWNER' || scope.rows.at(0)?.allowed !== true) {
            throw new InvitationRevocationError('INVITATION_REVOCATION_FORBIDDEN', 'La invitación está fuera de tu alcance.');
          }
        }
        return row;
    };
    const operation = async (client: PoolClient) => {
        const row = await authorize(client);
        if (row.status !== 'PENDING') {
          throw new InvitationRevocationError('INVITATION_NOT_REVOCABLE', 'La invitación no está disponible para revocación.');
        }

        const updated = await client.query(
          `UPDATE invitations
           SET status = 'REVOKED', revoked_at = $1
           WHERE organization_id = $2 AND id = $3 AND status = 'PENDING'`,
          [revokedAt, context.organizationId, invitationId],
        );
        if (updated.rowCount !== 1) {
          throw new InvitationRevocationError(
            'INVITATION_NOT_REVOCABLE',
            'La invitación no está disponible para revocación.',
          );
        }
        return { invitationId, status: 'REVOKED' as const };
      };
    if (idempotencyKey) {
      return this.transactions.runIdempotent(context, auditEvent, {
        actorUserId: context.userId, authorizationClass: 'MEMBERSHIP_ADMINISTRATION', branchId: null,
        key: idempotencyKey, organizationId: context.organizationId,
        payload: { invitationId }, scope: 'invitation.revoke',
      }, async (client) => { await authorize(client); }, operation,
      (body) => z.object({ invitationId: z.string(), status: z.literal('REVOKED') }).parse(body));
    }
    return this.transactions.run(context, auditEvent, operation);
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
    if (actor?.role !== 'OWNER' && actor?.role !== 'ADMIN') {
      throw new InvitationRevocationError(
        'INVITATION_REVOCATION_FORBIDDEN',
        'Solo OWNER o ADMIN pueden revocar invitaciones pendientes.',
      );
    }
    return actor;
  }
}
