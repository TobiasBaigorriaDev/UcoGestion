import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

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
  ): Promise<{ readonly invitationId: string; readonly status: 'REVOKED' }> {
    const revokedAt = this.now();
    return this.transactions.run(
      context,
      {
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
      },
      async (client) => {
        await this.requireManager(client, context);
        const invitation = await client.query<{ status: string }>(
          `SELECT status
           FROM invitations
           WHERE organization_id = $1 AND id = $2
           FOR UPDATE`,
          [context.organizationId, invitationId],
        );
        const row = invitation.rows.at(0);
        if (!row || row.status !== 'PENDING') {
          throw new InvitationRevocationError(
            'INVITATION_NOT_REVOCABLE',
            'La invitación no está disponible para revocación.',
          );
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
      },
    );
  }

  private async requireManager(
    client: PoolClient,
    context: TenantTransactionContext,
  ): Promise<void> {
    const membership = await client.query<{ role: string }>(
      `SELECT role
       FROM memberships
       WHERE organization_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [context.organizationId, context.userId],
    );
    const role = membership.rows.at(0)?.role;
    if (role !== 'OWNER' && role !== 'ADMIN') {
      throw new InvitationRevocationError(
        'INVITATION_REVOCATION_FORBIDDEN',
        'Solo OWNER o ADMIN pueden revocar invitaciones pendientes.',
      );
    }
  }
}
