import { ForbiddenException } from '@nestjs/common';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import type { MembershipRole } from './non-owner-membership.policy.js';

interface ActorRow { id: string; role: MembershipRole }
interface BranchRow { id: string; name: string; status: 'ACTIVE' | 'INACTIVE' }
interface MemberRow { id: string; email: string; role: MembershipRole; status: 'ACTIVE' | 'INACTIVE' | 'REVOKED'; version: number; branchIds: string[] }
interface InvitationRow { id: string; email: string; role: MembershipRole; status: string; expiresAt: Date; branchIds: string[] }

export class UserManagementReadService {
  constructor(private readonly transactions: TenantTransaction) {}

  async read(context: TenantTransactionContext) {
    return this.transactions.read(context, async (client) => {
      const actorResult = await client.query<ActorRow>(
        `SELECT id, role FROM memberships WHERE organization_id = $1 AND user_id = $2
         AND status = 'ACTIVE' AND revoked_at IS NULL`,
        [context.organizationId, context.userId],
      );
      const actor = actorResult.rows.at(0);
      if (!actor || actor.role !== 'OWNER' && actor.role !== 'ADMIN') {
        throw new ForbiddenException({ code: 'USER_MANAGEMENT_FORBIDDEN', title: 'Acceso denegado', detail: 'Solo OWNER o ADMIN pueden administrar usuarios.' });
      }
      const scope = await client.query<{ branchId: string }>(
        `SELECT branch_id AS "branchId" FROM effective_membership_branch_scope
         WHERE organization_id = $1 AND membership_id = $2`,
        [context.organizationId, actor.id],
      );
      const scopeSet = new Set(scope.rows.map((row) => row.branchId));
      const branches = await client.query<BranchRow>(
        `SELECT id, name, status FROM branches WHERE organization_id = $1 ORDER BY name, id`,
        [context.organizationId],
      );
      const memberships = await client.query<MemberRow>(
        `SELECT m.id, u.email_normalized AS email, m.role, m.status, m.version::integer AS version,
           COALESCE(array_agg(mb.branch_id::text ORDER BY mb.branch_id) FILTER (WHERE mb.branch_id IS NOT NULL), '{}') AS "branchIds"
         FROM memberships m JOIN users u ON u.id = m.user_id
         LEFT JOIN membership_branches mb ON mb.organization_id = m.organization_id AND mb.membership_id = m.id
         WHERE m.organization_id = $1 AND m.status <> 'REVOKED'
         GROUP BY m.id, u.email_normalized ORDER BY u.email_normalized`,
        [context.organizationId],
      );
      const invitations = await client.query<InvitationRow>(
        `SELECT i.id, i.email_normalized AS email, i.role, i.status, i.expires_at AS "expiresAt",
           COALESCE(array_agg(ib.branch_id::text ORDER BY ib.branch_id) FILTER (WHERE ib.branch_id IS NOT NULL), '{}') AS "branchIds"
         FROM invitations i LEFT JOIN invitation_branches ib ON ib.organization_id = i.organization_id AND ib.invitation_id = i.id
         WHERE i.organization_id = $1 AND i.status IN ('PENDING', 'EXPIRED')
         GROUP BY i.id ORDER BY i.email_normalized`,
        [context.organizationId],
      );
      const visible = (role: MembershipRole, ids: string[]) => actor.role === 'OWNER' || role !== 'OWNER' && ids.some((id) => scopeSet.has(id));
      return {
        actorRole: actor.role,
        branches: branches.rows.filter((row) => scopeSet.has(row.id)),
        memberships: memberships.rows.filter((row) => visible(row.role, row.branchIds)).map((row) => ({
          ...row,
          branchIds: row.branchIds.filter((id) => scopeSet.has(id)),
          hasOutsideScope: row.branchIds.some((id) => !scopeSet.has(id)),
        })),
        invitations: invitations.rows.filter((row) => visible(row.role, row.branchIds)).map((row) => ({
          ...row,
          branchIds: row.branchIds.filter((id) => scopeSet.has(id)),
          expiresAt: row.expiresAt.toISOString(),
        })),
      };
    });
  }
}
