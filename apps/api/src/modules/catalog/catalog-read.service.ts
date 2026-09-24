import { ForbiddenException } from '@nestjs/common';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

interface Actor { id: string; role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE' }
export interface Item { id: string; name: string; type: 'PRODUCT' | 'SERVICE'; status: 'ACTIVE' | 'INACTIVE'; baseUnit: 'UNIT' | 'FRACTIONAL'; price: string | null; priceVersion: number; sku: string | null; barcode: string | null }
export interface ManagedItem extends Item { trackInventory: boolean; version: number }
export interface Category { id: string; name: string }
export interface ManagedCategory extends Category { status: 'ACTIVE' | 'INACTIVE'; version: number }
type ReadOptions = Readonly<{ mode: 'HISTORICAL'; branchId: string }>;

export class CatalogReadService {
  constructor(private readonly transactions: TenantTransaction) {}

  async read(context: TenantTransactionContext, options?: ReadOptions): Promise<{ items: Item[]; categories: Category[] }> {
    return this.transactions.read(context, async (client) => {
      const actorResult = await client.query<Actor>(
        `SELECT id, role FROM memberships WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE' AND revoked_at IS NULL`,
        [context.organizationId, context.userId],
      );
      const actor = actorResult.rows.at(0);
      if (!actor) throw forbidden();
      if (options) {
        if (actor.role !== 'EMPLOYEE') throw forbidden();
        const scope = await client.query(
          `SELECT 1 FROM effective_membership_branch_scope scope JOIN branches b
             ON b.organization_id = scope.organization_id AND b.id = scope.branch_id
           WHERE scope.organization_id = $1 AND scope.membership_id = $2 AND scope.branch_id = $3 AND b.status = 'ACTIVE'`,
          [context.organizationId, actor.id, options.branchId],
        );
        if (scope.rowCount !== 1) throw forbidden();
      }
      const items = await client.query<Item>(
        `SELECT id, name, type, status, base_unit AS "baseUnit", price::text AS price,
                price_version::integer AS "priceVersion", sku, barcode
         FROM catalog_items
         WHERE organization_id = $1 AND ($2::boolean OR status = 'ACTIVE')
         ORDER BY name, id`,
        [context.organizationId, !!options],
      );
      const categories = await client.query<Category>(
        `SELECT id, name FROM catalog_categories WHERE organization_id = $1 AND status = 'ACTIVE' ORDER BY name, id`,
        [context.organizationId],
      );
      return { items: items.rows, categories: categories.rows };
    });
  }

  async readManagedCategories(context: TenantTransactionContext): Promise<{ categories: ManagedCategory[] }> {
    return this.transactions.read(context, async (client) => {
      const membership = await client.query<{ role: string }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2
         AND status = 'ACTIVE' AND revoked_at IS NULL`,
        [context.organizationId, context.userId],
      );
      if (!['OWNER', 'ADMIN'].includes(membership.rows[0]?.role ?? '')) throw forbidden();
      const result = await client.query<ManagedCategory>(
        `SELECT id, name, status, version::integer AS version FROM catalog_categories
         WHERE organization_id = $1 ORDER BY name, id`,
        [context.organizationId],
      );
      return { categories: result.rows };
    });
  }

  async readManagedItems(context: TenantTransactionContext): Promise<{ items: ManagedItem[] }> {
    return this.transactions.read(context, async (client) => {
      const membership = await client.query<{ role: string }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2
         AND status = 'ACTIVE' AND revoked_at IS NULL`,
        [context.organizationId, context.userId],
      );
      if (!['OWNER', 'ADMIN'].includes(membership.rows[0]?.role ?? '')) throw forbidden();
      const result = await client.query<ManagedItem>(
        `SELECT id, name, type, status, track_inventory AS "trackInventory", base_unit AS "baseUnit",
                price::text AS price, price_version::integer AS "priceVersion", sku, barcode,
                version::integer AS version
         FROM catalog_items WHERE organization_id = $1 ORDER BY name, id`, [context.organizationId],
      );
      return { items: result.rows };
    });
  }
}

function forbidden(): ForbiddenException {
  return new ForbiddenException({ code: 'CATALOG_READ_FORBIDDEN', title: 'Catálogo no disponible', detail: 'No tenés acceso a este contexto de catálogo.' });
}
