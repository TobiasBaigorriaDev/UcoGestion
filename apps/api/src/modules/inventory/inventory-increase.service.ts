import { randomUUID } from 'node:crypto';

import { Quantity } from '@uconext/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface InventoryIncreaseInput {
  readonly branchId: string;
  readonly itemId: string;
  readonly quantity: string;
  readonly reason: string;
  readonly observation?: string | null;
}

export interface InventoryIncreaseResult {
  readonly id: string;
  readonly branchId: string;
  readonly itemId: string;
  readonly quantity: string;
}

const replaySchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.string(),
});

/** Internal inventory use case; an HTTP command is introduced in a later task. */
export class InventoryIncreaseService {
  constructor(private readonly transactions: TenantTransaction) {}

  async confirm(context: TenantTransactionContext, input: InventoryIncreaseInput,
    idempotencyKey: string): Promise<InventoryIncreaseResult> {
    if (!input.reason.trim()) throw new RangeError('El motivo es obligatorio.');
    const canonicalQuantity = Quantity.from(input.quantity, 'FRACTIONAL').toString();
    const id = randomUUID();
    const authorize = async (client: PoolClient): Promise<void> => {
      const result = await client.query<{ role: string }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2
          AND status = 'ACTIVE' AND revoked_at IS NULL`, [context.organizationId, context.userId]);
      if (!['OWNER', 'ADMIN'].includes(result.rows[0]?.role ?? '')) {
        throw new Error('Ajuste de inventario no autorizado.');
      }
      const branch = await client.query(
        `SELECT 1 FROM branches b WHERE b.organization_id = $1 AND b.id = $2 AND b.status = 'ACTIVE'
          AND ($3 = 'OWNER' OR EXISTS (
            SELECT 1 FROM membership_branches mb JOIN memberships m
              ON m.organization_id = mb.organization_id AND m.id = mb.membership_id
            WHERE m.organization_id = $1 AND m.user_id = $4 AND mb.branch_id = b.id))`,
        [context.organizationId, input.branchId, result.rows[0]?.role, context.userId]);
      if (branch.rowCount !== 1) throw new Error('Sucursal no autorizada.');
    };
    return this.transactions.runIdempotent(context, {
      action: 'inventory.adjustment.increased',
      after: { direction: 'INCREASE', quantity: canonicalQuantity, reason: input.reason.trim(),
        observation: input.observation ?? null },
      afterAllowlist: ['direction', 'quantity', 'reason', 'observation'],
      before: {}, beforeAllowlist: [], branchId: input.branchId,
      context: {}, contextAllowlist: [], entityId: id, entityType: 'inventory_adjustment', operationId: id,
    }, {
      actorUserId: context.userId,
      authorizationClass: 'INVENTORY_INCREASE',
      branchId: input.branchId,
      key: idempotencyKey,
      organizationId: context.organizationId,
      payload: { branchId: input.branchId, itemId: input.itemId, quantity: canonicalQuantity,
        reason: input.reason.trim(), observation: input.observation ?? null },
      scope: 'inventory.adjustment.increase',
    }, authorize, async (client) => {
      const item = await client.query<{ base_unit: 'UNIT' | 'FRACTIONAL' }>(
        `SELECT base_unit FROM catalog_items WHERE organization_id = $1 AND id = $2
          AND type = 'PRODUCT' AND track_inventory AND status = 'ACTIVE'`,
        [context.organizationId, input.itemId]);
      const unit = item.rows[0]?.base_unit;
      if (!unit) throw new Error('Producto inventariable no disponible.');
      const quantity = Quantity.from(canonicalQuantity, unit).toString();
      await client.query(
        `SELECT inventory_api.apply_increase($1, $2, $3, $4, $5, $6::numeric, $7, $8)`,
        [id, context.organizationId, input.branchId, input.itemId, context.userId,
          quantity, input.reason.trim(), input.observation ?? null]);
      return { id, branchId: input.branchId, itemId: input.itemId, quantity };
    }, (body) => replaySchema.parse(body));
  }
}
