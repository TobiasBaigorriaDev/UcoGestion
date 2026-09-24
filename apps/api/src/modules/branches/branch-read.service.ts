import { ForbiddenException } from '@nestjs/common';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

interface ActorRow { id: string; role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE' }
interface BranchRow { id: string; name: string; status: 'ACTIVE' | 'INACTIVE'; version: number }

export class BranchReadService {
  constructor(private readonly transactions: TenantTransaction) {}

  async read(context: TenantTransactionContext): Promise<{ actorRole: ActorRow['role']; branches: BranchRow[] }> {
    return this.transactions.read(context, async (client) => {
      const actor = await client.query<ActorRow>(
        `SELECT id, role FROM memberships WHERE organization_id = $1 AND user_id = $2
         AND status = 'ACTIVE' AND revoked_at IS NULL`,
        [context.organizationId, context.userId],
      );
      const row = actor.rows.at(0);
      if (!row) throw new ForbiddenException({ code: 'BRANCH_READ_FORBIDDEN', title: 'Acceso denegado', detail: 'No tenés acceso a estas sucursales.' });
      const result = await client.query<BranchRow>(
        `SELECT b.id, b.name, b.status, b.version::integer AS version FROM branches b
         JOIN effective_membership_branch_scope scope
           ON scope.organization_id = b.organization_id AND scope.branch_id = b.id
         WHERE b.organization_id = $1 AND scope.membership_id = $2
           AND ($3 = 'OWNER' OR b.status = 'ACTIVE')
         ORDER BY b.name, b.id`,
        [context.organizationId, row.id, row.role],
      );
      return { actorRole: row.role, branches: result.rows };
    });
  }
}
