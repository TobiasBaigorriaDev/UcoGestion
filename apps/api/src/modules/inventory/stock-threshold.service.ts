import { randomUUID } from 'node:crypto';

import { parseCanonicalDecimal, Quantity } from '@uconext/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface StockSnapshot {
  readonly branchId: string;
  readonly itemId: string;
  readonly quantity: string;
  readonly threshold: string | null;
  readonly lowStock: boolean;
}

const replaySchema = z.object({ branchId: z.string().uuid(), itemId: z.string().uuid(),
  quantity: z.string(), threshold: z.string().nullable(), lowStock: z.boolean() });

export class StockThresholdService {
  constructor(private readonly transactions: TenantTransaction) {}

  async set(context: TenantTransactionContext, branchId: string, itemId: string,
    minimum: string | null, idempotencyKey: string): Promise<StockSnapshot> {
    const canonical = minimum === null ? null : canonicalThreshold(minimum);
    const id = randomUUID();
    const authorize = (client: PoolClient) => this.authorize(client, context, branchId, ['OWNER', 'ADMIN', 'EMPLOYEE']);
    return this.transactions.runIdempotent(context, {
      action: 'inventory.threshold.set', after: { minimum: canonical }, afterAllowlist: ['minimum'],
      before: {}, beforeAllowlist: [], branchId, context: {}, contextAllowlist: [],
      entityId: itemId, entityType: 'stock_threshold', operationId: id,
    }, {
      actorUserId: context.userId, authorizationClass: 'STOCK_THRESHOLD_WRITE', branchId,
      key: idempotencyKey, organizationId: context.organizationId,
      payload: { branchId, itemId, minimum: canonical }, scope: 'inventory.threshold.set',
    }, authorize, async (client) => {
      await client.query('SELECT inventory_api.set_threshold($1, $2, $3, $4, $5::numeric)',
        [context.organizationId, branchId, itemId, context.userId, canonical]);
      return this.readRow(client, context.organizationId, branchId, itemId);
    }, (body) => replaySchema.parse(body));
  }

  async read(context: TenantTransactionContext, branchId: string, itemId: string): Promise<StockSnapshot> {
    return this.transactions.read(context, async (client) => {
      await this.authorize(client, context, branchId, ['OWNER', 'ADMIN', 'EMPLOYEE', 'CASHIER']);
      return this.readRow(client, context.organizationId, branchId, itemId);
    });
  }

  private async authorize(client: PoolClient, context: TenantTransactionContext, branchId: string,
    roles: readonly string[]): Promise<void> {
    const result = await client.query<{ id: string; role: string }>(
      `SELECT id, role FROM memberships WHERE organization_id = $1 AND user_id = $2
        AND status = 'ACTIVE' AND revoked_at IS NULL`, [context.organizationId, context.userId]);
    if (!roles.includes(result.rows[0]?.role ?? '')) throw new Error('Stock no autorizado.');
    const branch = await client.query(
      `SELECT 1 FROM branches b WHERE b.organization_id = $1 AND b.id = $2 AND b.status = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM effective_membership_branch_scope s
          WHERE s.organization_id = b.organization_id AND s.branch_id = b.id AND s.membership_id = $3)`,
      [context.organizationId, branchId, result.rows[0]?.id]);
    if (branch.rowCount !== 1) throw new Error('Sucursal no autorizada.');
  }

  private async readRow(client: PoolClient, organizationId: string, branchId: string,
    itemId: string): Promise<StockSnapshot> {
    const result = await client.query<{ quantity: string; threshold: string | null; low_stock: boolean }>(
      `SELECT s.quantity::text AS quantity, t.minimum::text AS threshold,
              (t.minimum IS NOT NULL AND s.quantity <= t.minimum) AS low_stock
       FROM branch_stocks s JOIN catalog_items i ON i.organization_id = s.organization_id
         AND i.id = s.item_id AND i.status = 'ACTIVE' AND i.track_inventory
       LEFT JOIN stock_thresholds t
         ON t.organization_id = s.organization_id AND t.branch_id = s.branch_id AND t.item_id = s.item_id
       WHERE s.organization_id = $1 AND s.branch_id = $2 AND s.item_id = $3`,
      [organizationId, branchId, itemId]);
    const row = result.rows[0];
    if (!row) throw new Error('Stock no disponible.');
    return { branchId, itemId, quantity: row.quantity, threshold: row.threshold, lowStock: row.low_stock };
  }
}

function canonicalThreshold(value: string): string {
  const canonical = parseCanonicalDecimal(value);
  if (/^0(?:\.0{1,3})?$/.test(canonical)) return '0';
  return Quantity.from(canonical, 'FRACTIONAL').toString();
}
