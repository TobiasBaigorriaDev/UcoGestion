import { randomUUID } from 'node:crypto';

import { Quantity } from '@uconext/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { retryInventoryTransaction } from './inventory-transaction-retry.js';

export interface InventoryTransferInput {
  readonly originBranchId: string;
  readonly destinationBranchId: string;
  readonly lines: readonly { readonly itemId: string; readonly quantity: string }[];
}

export interface ValidatedTransfer {
  readonly originBranchId: string;
  readonly destinationBranchId: string;
  readonly lines: readonly { readonly itemId: string; readonly quantity: string }[];
}

export interface ConfirmedTransfer extends ValidatedTransfer { readonly id: string }
const replaySchema = z.object({ id: z.string().uuid(), originBranchId: z.string().uuid(),
  destinationBranchId: z.string().uuid(), lines: z.array(z.object({ itemId: z.string().uuid(), quantity: z.string() })) });

export class InventoryTransferService {
  constructor(private readonly transactions: TenantTransaction) {}

  async validate(context: TenantTransactionContext, input: InventoryTransferInput): Promise<ValidatedTransfer> {
    return this.transactions.read(context, (client) => this.validateInTransaction(client, context, input));
  }

  async confirm(context: TenantTransactionContext, input: InventoryTransferInput,
    idempotencyKey: string): Promise<ConfirmedTransfer> {
    return this.confirmInternal(context, input, idempotencyKey);
  }

  async compensate(context: TenantTransactionContext, originalId: string,
    idempotencyKey: string): Promise<ConfirmedTransfer> {
    const original = await this.transactions.read(context, async (client) => {
      const transfer = await client.query<{ origin_branch_id: string; destination_branch_id: string }>(
        `SELECT origin_branch_id, destination_branch_id FROM stock_transfers
          WHERE organization_id = $1 AND id = $2`, [context.organizationId, originalId]);
      if (!transfer.rows[0]) throw new Error('Transferencia original no disponible.');
      const lines = await client.query<{ item_id: string; quantity: string }>(
        `SELECT item_id, quantity FROM stock_transfer_lines
          WHERE organization_id = $1 AND transfer_id = $2 ORDER BY item_id`,
        [context.organizationId, originalId]);
      return { transfer: transfer.rows[0], lines: lines.rows };
    });
    return this.confirmInternal(context, {
      originBranchId: original.transfer.destination_branch_id,
      destinationBranchId: original.transfer.origin_branch_id,
      lines: original.lines.map((line) => ({ itemId: line.item_id, quantity: line.quantity })),
    }, idempotencyKey, originalId);
  }

  private async confirmInternal(context: TenantTransactionContext, input: InventoryTransferInput,
    idempotencyKey: string, compensatesTransferId?: string): Promise<ConfirmedTransfer> {
    const canonicalLines = input.lines.map((line) => ({ itemId: line.itemId,
      quantity: Quantity.from(line.quantity, 'FRACTIONAL').toString() }));
    const canonical = { originBranchId: input.originBranchId,
      destinationBranchId: input.destinationBranchId, lines: canonicalLines,
      ...(compensatesTransferId ? { compensatesTransferId } : {}) };
    const id = randomUUID();
    return retryInventoryTransaction(() => this.transactions.runIdempotent<ConfirmedTransfer>(context, {
      action: compensatesTransferId ? 'inventory.transfer.compensated' : 'inventory.transfer.confirmed',
      after: { originBranchId: input.originBranchId, destinationBranchId: input.destinationBranchId,
        lineCount: input.lines.length, compensatesTransferId: compensatesTransferId ?? null },
      afterAllowlist: ['originBranchId', 'destinationBranchId', 'lineCount', 'compensatesTransferId'],
      before: {}, beforeAllowlist: [], branchId: input.originBranchId,
      context: {}, contextAllowlist: [], entityId: id, entityType: 'stock_transfer', operationId: id,
    }, {
      actorUserId: context.userId, authorizationClass: 'STOCK_TRANSFER',
      branchId: input.originBranchId, key: idempotencyKey, organizationId: context.organizationId,
      payload: canonical, scope: compensatesTransferId ? 'inventory.transfer.compensation' : 'inventory.transfer',
    }, async (client) => { await this.validateInTransaction(client, context, canonical); }, async (client) => {
      if (compensatesTransferId) {
        const linked = await client.query(
          `SELECT 1 FROM stock_transfer_compensations
            WHERE organization_id = $1 AND (original_transfer_id = $2 OR compensation_transfer_id = $2)`,
          [context.organizationId, compensatesTransferId]);
        if (linked.rowCount) throw new Error('Transferencia ya compensada.');
      }
      const validated = await this.validateInTransaction(client, context, canonical);
      await this.lockAndCheck(client, context, validated);
      const lineIds = validated.lines.map(() => randomUUID());
      await client.query(
        'SELECT inventory_api.apply_transfer($1, $2, $3, $4, $5, $6::uuid[], $7::uuid[], $8::numeric[])',
        [id, context.organizationId, validated.originBranchId, validated.destinationBranchId,
          context.userId, lineIds, validated.lines.map((line) => line.itemId),
          validated.lines.map((line) => line.quantity)]);
      if (compensatesTransferId) {
        await client.query('SELECT inventory_api.link_transfer_compensation($1, $2, $3, $4)',
          [context.organizationId, compensatesTransferId, id, context.userId]);
      }
      return { id, ...validated };
    }, (body) => replaySchema.parse(body)));
  }

  async checkAvailability(context: TenantTransactionContext, input: InventoryTransferInput): Promise<ValidatedTransfer> {
    return this.transactions.runWithOptionalAudit(context, async (client) => {
      const validated = await this.validateInTransaction(client, context, input);
      await this.lockAndCheck(client, context, validated);
      return { result: validated };
    });
  }

  private async lockAndCheck(client: PoolClient, context: TenantTransactionContext,
    input: ValidatedTransfer): Promise<void> {
    const pairs = [input.originBranchId, input.destinationBranchId]
      .flatMap((branchId) => input.lines.map((line) => ({ branchId, itemId: line.itemId, quantity: line.quantity })))
      .sort((left, right) => left.branchId.localeCompare(right.branchId) || left.itemId.localeCompare(right.itemId));
    for (const pair of pairs) {
      const result = await client.query<{ insufficient: boolean }>(
        'SELECT inventory_api.lock_transfer_stock($1, $2, $3, $4, $5::numeric) AS insufficient',
        [context.organizationId, pair.branchId, pair.itemId, context.userId, pair.quantity]);
      if (pair.branchId === input.originBranchId && result.rows[0]?.insufficient) {
        throw new Error('Stock insuficiente para transferencia.');
      }
    }
    await this.validateInTransaction(client, context, input);
  }

  private async validateInTransaction(client: PoolClient, context: TenantTransactionContext,
    input: InventoryTransferInput): Promise<ValidatedTransfer> {
    if (input.originBranchId === input.destinationBranchId || input.lines.length === 0) {
      throw new RangeError('La transferencia requiere dos sucursales distintas y al menos un producto.');
    }
    const ids = input.lines.map((line) => line.itemId);
    if (new Set(ids).size !== ids.length) throw new RangeError('No repitas productos en la transferencia.');
    const membership = await client.query<{ id: string; role: string }>(
      `SELECT id, role FROM memberships WHERE organization_id = $1 AND user_id = $2
        AND status = 'ACTIVE' AND revoked_at IS NULL`, [context.organizationId, context.userId]);
    const actor = membership.rows[0];
    if (!actor || !['OWNER', 'ADMIN', 'EMPLOYEE'].includes(actor.role)) {
      throw new Error('Transferencia no autorizada.');
    }
    const branches = await client.query<{ id: string }>(
      `SELECT b.id FROM branches b JOIN effective_membership_branch_scope s
         ON s.organization_id = b.organization_id AND s.branch_id = b.id
       WHERE b.organization_id = $1 AND b.id = ANY($2::uuid[]) AND b.status = 'ACTIVE'
         AND s.membership_id = $3`,
      [context.organizationId, [input.originBranchId, input.destinationBranchId], actor.id]);
    if (branches.rowCount !== 2) throw new Error('Sucursales no autorizadas.');
    const items = await client.query<{ id: string; base_unit: 'UNIT' | 'FRACTIONAL' }>(
      `SELECT id, base_unit FROM catalog_items WHERE organization_id = $1 AND id = ANY($2::uuid[])
        AND type = 'PRODUCT' AND track_inventory AND status = 'ACTIVE'`, [context.organizationId, ids]);
    if (items.rowCount !== ids.length) throw new Error('Producto inventariable no disponible.');
    const units = new Map(items.rows.map((item) => [item.id, item.base_unit]));
    return { originBranchId: input.originBranchId, destinationBranchId: input.destinationBranchId,
      lines: input.lines.map((line) => {
        const unit = units.get(line.itemId);
        if (!unit) throw new Error('Producto inventariable no disponible.');
        return { itemId: line.itemId, quantity: Quantity.from(line.quantity, unit).toString() };
      }) };
  }
}
