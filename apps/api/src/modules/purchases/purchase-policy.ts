import type { PoolClient } from 'pg';

import type { TenantTransactionContext } from '../../database/tenant-transaction.js';

export type PurchaseAction = 'CREATE' | 'CONFIRM_PENDING' | 'CONFIRM_PAID' | 'PAY' | 'CANCEL';
export type PurchaseActorRole = 'OWNER' | 'ADMIN' | 'EMPLOYEE';

export class PurchaseAuthorizationError extends Error {
  readonly code = 'PURCHASE_FORBIDDEN' as const;
  constructor() { super('No tenés permiso para operar esta compra.'); this.name = 'PurchaseAuthorizationError'; }
}

export class PurchasePolicy {
  async authorize(client: PoolClient, context: TenantTransactionContext, branchId: string,
    action: PurchaseAction): Promise<PurchaseActorRole> {
    const result = await client.query<{ role: string; allowed: boolean }>(`SELECT m.role,
      (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope s
        WHERE s.organization_id = m.organization_id AND s.membership_id = m.id
          AND s.branch_id = $3)) AS allowed
      FROM memberships m JOIN branches b ON b.organization_id = m.organization_id AND b.id = $3
      WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE'
        AND m.revoked_at IS NULL AND b.status = 'ACTIVE'`,
    [context.organizationId, context.userId, branchId]);
    const actor = result.rows[0];
    if (!actor?.allowed || (action !== 'CONFIRM_PENDING' && action !== 'CONFIRM_PAID' && action !== 'PAY' && action !== 'CANCEL')
      || (actor.role !== 'OWNER' && actor.role !== 'ADMIN'
        && (actor.role !== 'EMPLOYEE' || action !== 'CONFIRM_PENDING'))) {
      throw new PurchaseAuthorizationError();
    }
    return actor.role;
  }
}
