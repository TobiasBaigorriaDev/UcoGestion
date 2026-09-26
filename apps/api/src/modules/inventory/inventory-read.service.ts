import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export class InventoryReadService {
  constructor(private readonly transactions: TenantTransaction) {}

  async adjustments(context: TenantTransactionContext, branchId: string, after?: string) {
    return this.transactions.read(context, async (client) => {
      await this.authorize(client, context, [branchId], ['OWNER', 'ADMIN', 'EMPLOYEE']);
      const rows = await client.query<{ id: string; item_id: string; item_name: string; direction: string;
        quantity: string; reason: string; observation: string | null; occurred_at: string;
        compensated_by: string | null; compensates: string | null }>(
        `SELECT a.id, a.item_id, i.name AS item_name, a.direction, a.quantity::text AS quantity,
          a.reason, a.observation, a.occurred_at::text AS occurred_at,
          c.compensation_adjustment_id AS compensated_by,
          reverse_link.original_adjustment_id AS compensates
        FROM inventory_adjustments a JOIN catalog_items i
          ON i.organization_id = a.organization_id AND i.id = a.item_id
        LEFT JOIN inventory_adjustment_compensations c ON c.organization_id = a.organization_id
          AND c.original_adjustment_id = a.id
        LEFT JOIN inventory_adjustment_compensations reverse_link ON reverse_link.organization_id = a.organization_id
          AND reverse_link.compensation_adjustment_id = a.id
        WHERE a.organization_id = $1 AND a.branch_id = $2 AND ($3::uuid IS NULL OR a.id > $3::uuid)
        ORDER BY a.id LIMIT 101`, [context.organizationId, branchId, after ?? null]);
      const page = rows.rows.slice(0, 100);
      return { adjustments: page.map((row) => ({ id: row.id, branchId, itemId: row.item_id,
        itemName: row.item_name, direction: row.direction, quantity: row.quantity, reason: row.reason,
        observation: row.observation, occurredAt: row.occurred_at,
        compensatedBy: row.compensated_by, compensates: row.compensates })),
      nextCursor: rows.rows.length > 100 ? page.at(-1)?.id ?? null : null };
    });
  }

  async transfers(context: TenantTransactionContext, branchId: string, after?: string) {
    return this.transactions.read(context, async (client) => {
      await this.authorize(client, context, [branchId], ['OWNER', 'ADMIN', 'EMPLOYEE']);
      const rows = await client.query<{ id: string; origin_branch_id: string; destination_branch_id: string;
        occurred_at: string; compensated_by: string | null; compensates: string | null }>(
        `SELECT t.id, t.origin_branch_id, t.destination_branch_id, t.occurred_at::text AS occurred_at,
          c.compensation_transfer_id AS compensated_by, reverse_link.original_transfer_id AS compensates
        FROM stock_transfers t
        LEFT JOIN stock_transfer_compensations c ON c.organization_id = t.organization_id
          AND c.original_transfer_id = t.id
        LEFT JOIN stock_transfer_compensations reverse_link ON reverse_link.organization_id = t.organization_id
          AND reverse_link.compensation_transfer_id = t.id
        WHERE t.organization_id = $1 AND (t.origin_branch_id = $2 OR t.destination_branch_id = $2)
          AND ($3::uuid IS NULL OR t.id > $3::uuid)
        ORDER BY t.id LIMIT 101`, [context.organizationId, branchId, after ?? null]);
      const page = rows.rows.slice(0, 100);
      const membership = await client.query<{ id: string }>(
        `SELECT id FROM memberships WHERE organization_id = $1 AND user_id = $2
          AND status = 'ACTIVE' AND revoked_at IS NULL`, [context.organizationId, context.userId]);
      const accessible = await client.query<{ branch_id: string }>(
        `SELECT branch_id FROM effective_membership_branch_scope WHERE organization_id = $1 AND membership_id = $2`,
        [context.organizationId, membership.rows[0]?.id]);
      const scope = new Set(accessible.rows.map((row) => row.branch_id));
      const visible = page.filter((row) => scope.has(row.origin_branch_id) && scope.has(row.destination_branch_id));
      const lines = visible.length ? await client.query<{ transfer_id: string; item_id: string; item_name: string; quantity: string }>(
        `SELECT l.transfer_id, l.item_id, i.name AS item_name, l.quantity::text AS quantity
        FROM stock_transfer_lines l JOIN catalog_items i ON i.organization_id = l.organization_id AND i.id = l.item_id
        WHERE l.organization_id = $1 AND l.transfer_id = ANY($2::uuid[]) ORDER BY l.transfer_id, l.item_id`,
        [context.organizationId, visible.map((row) => row.id)]) : { rows: [] };
      return { transfers: visible.map((row) => ({ id: row.id, originBranchId: row.origin_branch_id,
        destinationBranchId: row.destination_branch_id, occurredAt: row.occurred_at,
        compensatedBy: row.compensated_by, compensates: row.compensates,
        lines: lines.rows.filter((line) => line.transfer_id === row.id).map((line) => ({ itemId: line.item_id,
          itemName: line.item_name, quantity: line.quantity })) })),
      nextCursor: rows.rows.length > 100 ? page.at(-1)?.id ?? null : null };
    });
  }

  private async authorize(client: PoolClient, context: TenantTransactionContext,
    branchIds: readonly string[], roles: readonly string[]) {
    const membership = await client.query<{ id: string; role: string }>(
      `SELECT id, role FROM memberships WHERE organization_id = $1 AND user_id = $2
        AND status = 'ACTIVE' AND revoked_at IS NULL`, [context.organizationId, context.userId]);
    const actor = membership.rows[0];
    if (!actor || !roles.includes(actor.role)) throw new Error('Inventario no autorizado.');
    const branches = await client.query<{ id: string }>(
      `SELECT b.id FROM branches b WHERE b.organization_id = $1 AND b.id = ANY($2::uuid[])
        AND b.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM effective_membership_branch_scope s
          WHERE s.organization_id = b.organization_id AND s.branch_id = b.id AND s.membership_id = $3)`,
      [context.organizationId, branchIds, actor.id]);
    if (branches.rowCount !== new Set(branchIds).size) throw new Error('Sucursal no autorizada.');
  }
}
