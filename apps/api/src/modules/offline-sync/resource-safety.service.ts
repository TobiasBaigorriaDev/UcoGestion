import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export type ResourceSafety = 'CLEAR' | 'UNCERTAIN' | 'HISTORY';
export type CurrencySafety = ResourceSafety | 'PERMANENT';
export type OfflineResource =
  | { readonly kind: 'CATALOG_ITEM'; readonly id: string }
  | { readonly kind: 'CATALOG_CATEGORY'; readonly id: string }
  | { readonly kind: 'BRANCH'; readonly id: string }
  | { readonly kind: 'CASH_REGISTER'; readonly id: string }
  | { readonly kind: 'PAYMENT_METHOD'; readonly id: string };

const resourceColumn = {
  CATALOG_ITEM: 'catalog_item_id',
  CATALOG_CATEGORY: 'catalog_category_id',
  BRANCH: 'branch_id',
  CASH_REGISTER: 'cash_register_id',
  PAYMENT_METHOD: 'payment_method',
} as const;

export class ResourceSafetyService {
  constructor(private readonly transactions: TenantTransaction) {}

  async catalogItem(context: TenantTransactionContext, itemId: string): Promise<ResourceSafety> {
    return this.resource(context, { kind: 'CATALOG_ITEM', id: itemId });
  }

  async resource(context: TenantTransactionContext, target: OfflineResource): Promise<ResourceSafety> {
    return this.transactions.read(context, async (client) => {
      await this.requireMembership(client, context);
      return this.resourceInTransaction(client, context.organizationId, target);
    });
  }

  async resourceInTransaction(
    client: PoolClient,
    organizationId: string,
    target: OfflineResource,
  ): Promise<ResourceSafety> {
    const column = resourceColumn[target.kind];
    const history = await client.query(
      `SELECT 1 FROM resource_history_references WHERE organization_id = $1 AND ${column} = $2 LIMIT 1`,
      [organizationId, target.id],
    );
    if ((history.rowCount ?? 0) > 0) return 'HISTORY';
    const uncertainty = await client.query(
      `SELECT 1 FROM offline_exposure_resources r
       JOIN offline_configuration_exposures e ON e.organization_id = r.organization_id
         AND e.id = r.exposure_id
       WHERE r.organization_id = $1 AND r.${column} = $2 AND e.cleared_at IS NULL LIMIT 1`,
      [organizationId, target.id],
    );
    return (uncertainty.rowCount ?? 0) > 0 ? 'UNCERTAIN' : 'CLEAR';
  }

  async currency(context: TenantTransactionContext): Promise<CurrencySafety> {
    return this.transactions.read(context, async (client) => {
      await this.requireMembership(client, context);
      return this.currencyInTransaction(client, context.organizationId);
    });
  }

  async currencyInTransaction(client: PoolClient, organizationId: string): Promise<CurrencySafety> {
    const organization = await client.query<{
      currency_permanently_locked_at: Date | null;
      operational_history_started_at: Date | null;
    }>(
      `SELECT currency_permanently_locked_at, operational_history_started_at
       FROM organizations WHERE id = $1`,
      [organizationId],
    );
    const row = organization.rows[0];
    if (!row) return 'UNCERTAIN';
    if (row.currency_permanently_locked_at !== null) return 'PERMANENT';
    if (row.operational_history_started_at !== null) return 'HISTORY';
    const grant = await client.query(
      `SELECT 1 FROM offline_grants WHERE organization_id = $1 AND closed_at IS NULL LIMIT 1`,
      [organizationId],
    );
    if ((grant.rowCount ?? 0) > 0) return 'UNCERTAIN';
    const exposure = await client.query(
      `SELECT 1 FROM offline_configuration_exposures
       WHERE organization_id = $1 AND cleared_at IS NULL LIMIT 1`,
      [organizationId],
    );
    return (exposure.rowCount ?? 0) > 0 ? 'UNCERTAIN' : 'CLEAR';
  }

  private async requireMembership(client: PoolClient, context: TenantTransactionContext): Promise<void> {
    const membership = await client.query(
      `SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2
       AND status = 'ACTIVE' AND revoked_at IS NULL`,
      [context.organizationId, context.userId],
    );
    if ((membership.rowCount ?? 0) === 0) throw new Error('MEMBERSHIP_INACTIVE');
  }
}
