import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface InventoryDivergence {
  readonly organizationId: string;
  readonly branchId: string;
  readonly itemId: string;
  readonly projected: string;
  readonly ledger: string;
}

export interface InventoryVerificationResult {
  readonly checked: number;
  readonly divergent: number;
}

type Alert = (divergence: InventoryDivergence) => void;

/** A read-only reconciliation. Repairs must be explicit business operations. */
export class InventoryLedgerVerifier {
  constructor(private readonly transactions: TenantTransaction, private readonly alert: Alert) {}

  async verify(context: TenantTransactionContext): Promise<InventoryVerificationResult> {
    return this.transactions.read(context, async (client: PoolClient) => {
      const actor = await client.query(`SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2
        AND status = 'ACTIVE' AND revoked_at IS NULL`, [context.organizationId, context.userId]);
      if (actor.rowCount !== 1) throw new Error('Inventory verification context is not an active member.');
      const result = await client.query<{
        branch_id: string; item_id: string; projected: string; ledger: string;
      }>(`SELECT s.branch_id, s.item_id, s.quantity::text AS projected,
          COALESCE(SUM(m.delta), 0)::numeric(20,3)::text AS ledger
        FROM branch_stocks s
        LEFT JOIN inventory_movements m
          ON m.organization_id = s.organization_id AND m.branch_id = s.branch_id AND m.item_id = s.item_id
        WHERE s.organization_id = $1
        GROUP BY s.organization_id, s.branch_id, s.item_id, s.quantity
        ORDER BY s.branch_id, s.item_id`, [context.organizationId]);
      let divergent = 0;
      for (const row of result.rows) {
        if (row.projected !== row.ledger) {
          divergent += 1;
          this.alert({ organizationId: context.organizationId, branchId: row.branch_id,
            itemId: row.item_id, projected: row.projected, ledger: row.ledger });
        }
      }
      return { checked: result.rows.length, divergent };
    });
  }
}
