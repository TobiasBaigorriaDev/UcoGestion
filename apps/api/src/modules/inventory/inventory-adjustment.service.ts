import { randomUUID } from 'node:crypto';

import { Quantity } from '@uconext/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { retryInventoryTransaction } from './inventory-transaction-retry.js';

export interface InventoryAdjustmentInput {
  readonly branchId: string;
  readonly itemId: string;
  readonly direction: 'INCREASE' | 'DECREASE';
  readonly quantity: string;
  readonly reason: string;
  readonly observation?: string | null;
  readonly compensatesAdjustmentId?: string;
}

export interface InventoryAdjustmentResult {
  readonly id: string;
  readonly branchId: string;
  readonly itemId: string;
  readonly quantity: string;
}

const reasons = new Set(['INVENTARIO_INICIAL', 'CONTEO_FISICO', 'ROTURA', 'PERDIDA',
  'VENCIMIENTO', 'CORRECCION', 'OTRO']);

const replaySchema = z.object({
  id: z.string().uuid(), branchId: z.string().uuid(), itemId: z.string().uuid(), quantity: z.string(),
});

/** Internal adjustment use case. The HTTP command is introduced in T105A. */
export class InventoryAdjustmentService {
  constructor(private readonly transactions: TenantTransaction) {}

  async compensate(context: TenantTransactionContext, originalId: string,
    observation: string | null, idempotencyKey: string): Promise<InventoryAdjustmentResult> {
    const original = await this.transactions.read(context, async (client) => {
      const result = await client.query<{ branch_id: string; item_id: string;
        direction: 'INCREASE' | 'DECREASE'; quantity: string }>(
        `SELECT branch_id, item_id, direction, quantity FROM inventory_adjustments
          WHERE organization_id = $1 AND id = $2`, [context.organizationId, originalId]);
      return result.rows[0];
    });
    if (!original) throw new Error('Ajuste original no disponible.');
    return this.confirm(context, {
      branchId: original.branch_id, itemId: original.item_id,
      direction: original.direction === 'INCREASE' ? 'DECREASE' : 'INCREASE',
      quantity: original.quantity, reason: 'CORRECCION', observation,
      compensatesAdjustmentId: originalId,
    }, idempotencyKey);
  }

  async confirm(context: TenantTransactionContext, input: InventoryAdjustmentInput,
    idempotencyKey: string): Promise<InventoryAdjustmentResult> {
    if (!reasons.has(input.reason.trim())) throw new RangeError('Motivo de ajuste inválido.');
    const canonicalQuantity = Quantity.from(input.quantity, 'FRACTIONAL').toString();
    const id = randomUUID();
    const authorize = async (client: PoolClient): Promise<void> => {
      const result = await client.query<{ role: string }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2
          AND status = 'ACTIVE' AND revoked_at IS NULL`, [context.organizationId, context.userId]);
      if (!['OWNER', 'ADMIN', 'EMPLOYEE'].includes(result.rows[0]?.role ?? '')
        || (result.rows[0]?.role === 'EMPLOYEE' && input.reason.trim() === 'INVENTARIO_INICIAL')) {
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
    return retryInventoryTransaction(() => this.transactions.runIdempotent(context, {
      action: `inventory.adjustment.${input.direction === 'INCREASE' ? 'increased' : 'decreased'}`,
      after: { direction: input.direction, quantity: canonicalQuantity, reason: input.reason.trim(),
        observation: input.observation ?? null, compensatesAdjustmentId: input.compensatesAdjustmentId ?? null },
      afterAllowlist: ['direction', 'quantity', 'reason', 'observation', 'compensatesAdjustmentId'],
      before: {}, beforeAllowlist: [], branchId: input.branchId,
      context: {}, contextAllowlist: [], entityId: id, entityType: 'inventory_adjustment', operationId: id,
    }, {
      actorUserId: context.userId,
      authorizationClass: 'INVENTORY_ADJUSTMENT',
      branchId: input.branchId, key: idempotencyKey, organizationId: context.organizationId,
      payload: { branchId: input.branchId, itemId: input.itemId, direction: input.direction,
        quantity: canonicalQuantity, reason: input.reason.trim(), observation: input.observation ?? null,
        compensatesAdjustmentId: input.compensatesAdjustmentId ?? null },
      scope: 'inventory.adjustment',
    }, authorize, async (client) => {
      const item = await client.query<{ base_unit: 'UNIT' | 'FRACTIONAL' }>(
        `SELECT base_unit FROM catalog_items WHERE organization_id = $1 AND id = $2
          AND type = 'PRODUCT' AND track_inventory AND status = 'ACTIVE'`,
        [context.organizationId, input.itemId]);
      const unit = item.rows[0]?.base_unit;
      if (!unit) throw new Error('Producto inventariable no disponible.');
      const quantity = Quantity.from(canonicalQuantity, unit).toString();
      await client.query(
        'SELECT inventory_api.apply_adjustment($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9)',
        [id, context.organizationId, input.branchId, input.itemId, context.userId,
          input.direction, quantity, input.reason.trim(), input.observation ?? null]);
      if (input.compensatesAdjustmentId) {
        await client.query('SELECT inventory_api.link_compensation($1, $2, $3, $4)',
          [context.organizationId, input.compensatesAdjustmentId, id, context.userId]);
      }
      return { id, branchId: input.branchId, itemId: input.itemId, quantity };
    }, (body) => replaySchema.parse(body)));
  }
}
