import type { PoolClient } from 'pg';

import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDevicePolicy } from '../cash/index.js';

export type ExpenseActorRole = 'OWNER' | 'ADMIN' | 'CASHIER';
export class ExpenseAuthorizationError extends Error {
  readonly code = 'EXPENSE_FORBIDDEN' as const;
  constructor() { super('No tenés permiso para registrar este gasto.'); this.name = 'ExpenseAuthorizationError'; }
}

export class ExpensePolicy {
  private readonly sessions = new CashSessionDevicePolicy();

  async authorize(client: PoolClient, context: TenantTransactionContext,
    input: { branchId: string; method: string; cashSessionId?: string | undefined;
      deviceId?: string | undefined }): Promise<ExpenseActorRole> {
    const result = await client.query<{ role: string; allowed: boolean }>(`SELECT m.role,
      (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope s
        WHERE s.organization_id = m.organization_id AND s.membership_id = m.id
          AND s.branch_id = $3)) AS allowed
      FROM memberships m JOIN branches b ON b.organization_id = m.organization_id AND b.id = $3
      WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE'
        AND m.revoked_at IS NULL AND b.status = 'ACTIVE'`,
    [context.organizationId, context.userId, input.branchId]);
    const actor = result.rows[0];
    if (!actor?.allowed || !['OWNER', 'ADMIN', 'CASHIER'].includes(actor.role)
      || (actor.role === 'CASHIER' && input.method !== 'CASH')) throw new ExpenseAuthorizationError();
    if (input.method === 'CASH') {
      if (!input.cashSessionId || !input.deviceId) throw new ExpenseAuthorizationError();
      const session = await this.sessions.requireOperational(client, context.organizationId,
        input.cashSessionId, input.deviceId);
      if (session.branchId !== input.branchId
        || (actor.role === 'CASHIER' && session.ownerUserId !== context.userId)) {
        throw new ExpenseAuthorizationError();
      }
    } else if (input.cashSessionId || input.deviceId) {
      throw new ExpenseAuthorizationError();
    }
    return actor.role as ExpenseActorRole;
  }
}
