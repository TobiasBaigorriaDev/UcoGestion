import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export type CatalogItemType = 'PRODUCT' | 'SERVICE';
export type CatalogItemBaseUnit = 'UNIT' | 'FRACTIONAL';

export interface CatalogItemCreateInput {
  readonly barcode?: string | null;
  readonly baseUnit?: CatalogItemBaseUnit;
  readonly name: string;
  readonly sku?: string | null;
  readonly trackInventory?: boolean;
  readonly type: CatalogItemType;
}

export interface CatalogItemResult {
  readonly barcode: string | null;
  readonly baseUnit: CatalogItemBaseUnit;
  readonly id: string;
  readonly name: string;
  readonly sku: string | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly trackInventory: boolean;
  readonly type: CatalogItemType;
  readonly version: number;
}

export type CatalogItemCreationErrorCode =
  | 'CATALOG_ITEM_BARCODE_DUPLICATE'
  | 'CATALOG_ITEM_BASE_UNIT_INVALID'
  | 'CATALOG_ITEM_CREATION_FORBIDDEN'
  | 'CATALOG_ITEM_NAME_INVALID'
  | 'CATALOG_ITEM_SERVICE_TRACK_INVENTORY_NOT_ALLOWED'
  | 'CATALOG_ITEM_SKU_DUPLICATE';

export class CatalogItemCreationError extends Error {
  constructor(
    readonly code: CatalogItemCreationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogItemCreationError';
  }
}

export class CatalogItemCreationService {
  constructor(private readonly transactions: TenantTransaction) {}

  async create(
    context: TenantTransactionContext,
    input: CatalogItemCreateInput,
  ): Promise<CatalogItemResult> {
    const id = randomUUID();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new CatalogItemCreationError(
        'CATALOG_ITEM_NAME_INVALID',
        'El nombre del ítem de catálogo es obligatorio.',
      );
    }
    if (input.type === 'SERVICE' && input.trackInventory !== undefined) {
      throw new CatalogItemCreationError(
        'CATALOG_ITEM_SERVICE_TRACK_INVENTORY_NOT_ALLOWED',
        'Los servicios no pueden configurar control de inventario.',
      );
    }
    if (input.baseUnit !== undefined && !['UNIT', 'FRACTIONAL'].includes(input.baseUnit)) {
      throw new CatalogItemCreationError(
        'CATALOG_ITEM_BASE_UNIT_INVALID',
        'La unidad de medida del ítem debe ser UNIT o FRACTIONAL.',
      );
    }

    const rawSku = input.sku !== undefined && input.sku !== null ? input.sku.trim() : null;
    const sku = rawSku && rawSku.length > 0 ? rawSku : null;

    const rawBarcode = input.barcode !== undefined && input.barcode !== null ? input.barcode.trim() : null;
    const barcode = rawBarcode && rawBarcode.length > 0 ? rawBarcode : null;

    const baseUnit: CatalogItemBaseUnit = input.baseUnit ?? 'UNIT';
    const trackInventory = input.type === 'PRODUCT' ? (input.trackInventory === true) : false;

    return this.transactions.run(
      context,
      {
        action: 'catalog_item.created',
        after: { barcode, baseUnit, name, sku, status: 'ACTIVE', trackInventory, type: input.type },
        afterAllowlist: ['barcode', 'baseUnit', 'name', 'sku', 'status', 'trackInventory', 'type'],
        before: {},
        beforeAllowlist: [],
        branchId: null,
        context: {},
        contextAllowlist: [],
        entityId: id,
        entityType: 'catalog_item',
        operationId: id,
      },
      async (client) => {
        await this.requireOwnerOrAdmin(client, context);

        if (sku !== null) {
          const existingSku = await client.query<{ id: string }>(
            `SELECT id FROM catalog_items
             WHERE organization_id = $1 AND sku_norm = upper($2)`,
            [context.organizationId, sku],
          );
          if ((existingSku.rowCount ?? 0) > 0) {
            throw new CatalogItemCreationError(
              'CATALOG_ITEM_SKU_DUPLICATE',
              'Ya existe un ítem con el mismo SKU en la organización.',
            );
          }
        }

        if (barcode !== null) {
          const existingBarcode = await client.query<{ id: string }>(
            `SELECT id FROM catalog_items
             WHERE organization_id = $1 AND barcode_norm = upper($2)`,
            [context.organizationId, barcode],
          );
          if ((existingBarcode.rowCount ?? 0) > 0) {
            throw new CatalogItemCreationError(
              'CATALOG_ITEM_BARCODE_DUPLICATE',
              'Ya existe un ítem con el mismo código de barras en la organización.',
            );
          }
        }

        try {
          const result = await client.query<CatalogItemResult>(
            `INSERT INTO catalog_items (id, organization_id, name, type, track_inventory, base_unit, sku, barcode, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE')
             RETURNING id, name, status, track_inventory AS "trackInventory", base_unit AS "baseUnit",
               sku, barcode, type, version::integer AS version`,
            [id, context.organizationId, name, input.type, trackInventory, baseUnit, sku, barcode],
          );
          const row = result.rows.at(0);
          if (!row) throw new Error('El ítem de catálogo no fue persistido.');
          return row;
        } catch (error: unknown) {
          if (typeof error === 'object' && error !== null && 'constraint' in error) {
            const constraint = (error as { constraint?: unknown }).constraint;
            if (constraint === 'catalog_items_organization_sku_norm_key') {
              throw new CatalogItemCreationError(
                'CATALOG_ITEM_SKU_DUPLICATE',
                'Ya existe un ítem con el mismo SKU en la organización.',
              );
            }
            if (constraint === 'catalog_items_organization_barcode_norm_key') {
              throw new CatalogItemCreationError(
                'CATALOG_ITEM_BARCODE_DUPLICATE',
                'Ya existe un ítem con el mismo código de barras en la organización.',
              );
            }
          }
          throw error;
        }
      },
    );
  }

  async findSimilarNames(
    context: TenantTransactionContext,
    name: string,
  ): Promise<readonly string[]> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return [];
    }
    return this.transactions.read(context, async (client) => {
      const pattern = `%${trimmed}%`;
      const result = await client.query<{ name: string }>(
        `SELECT DISTINCT name FROM catalog_items
         WHERE organization_id = $1
           AND (lower(btrim(name)) = lower($2) OR name ILIKE $3)
         ORDER BY name
         LIMIT 10`,
        [context.organizationId, trimmed, pattern],
      );
      return result.rows.map((row) => row.name);
    });
  }

  private async requireOwnerOrAdmin(
    client: PoolClient,
    context: TenantTransactionContext,
  ): Promise<void> {
    const membership = await client.query<{ role: string }>(
      `SELECT role FROM memberships
       WHERE organization_id = $1 AND user_id = $2
         AND status = 'ACTIVE' AND revoked_at IS NULL`,
      [context.organizationId, context.userId],
    );
    if (!['OWNER', 'ADMIN'].includes(membership.rows.at(0)?.role ?? '')) {
      throw new CatalogItemCreationError(
        'CATALOG_ITEM_CREATION_FORBIDDEN',
        'Solo OWNER o ADMIN pueden crear ítems de catálogo.',
      );
    }
  }
}
