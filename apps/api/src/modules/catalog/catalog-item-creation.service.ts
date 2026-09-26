import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError, IdempotencyService } from '../../core/idempotency/idempotency.service.js';
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
  | 'CATALOG_ITEM_SKU_DUPLICATE'
  | 'IDEMPOTENCY_KEY_REUSED';

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
        await client.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [context.organizationId]);

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

  async createIdempotent(context: TenantTransactionContext, input: CatalogItemCreateInput,
    key: string): Promise<CatalogItemResult> {
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) {
      throw new CatalogItemCreationError('IDEMPOTENCY_KEY_REUSED', 'Clave idempotente inválida.');
    }
    const name = input.name.trim();
    if (!name) throw new CatalogItemCreationError('CATALOG_ITEM_NAME_INVALID', 'El nombre del ítem es obligatorio.');
    if (input.type === 'SERVICE' && input.trackInventory !== undefined) {
      throw new CatalogItemCreationError('CATALOG_ITEM_SERVICE_TRACK_INVENTORY_NOT_ALLOWED', 'Un servicio no controla inventario.');
    }
    const sku = input.sku?.trim() || null;
    const barcode = input.barcode?.trim() || null;
    const baseUnit = input.baseUnit ?? 'UNIT';
    const trackInventory = input.type === 'PRODUCT' && input.trackInventory === true;
    const id = randomUUID();
    try {
      return await this.transactions.runWithOptionalAudit(context, async (client) => {
        await this.requireOwnerOrAdmin(client, context);
        const idempotency = new IdempotencyService(client);
        const acquired = await idempotency.acquire({ actorUserId: context.userId,
          authorizationClass: 'OWNER_OR_ADMIN', branchId: null, key,
          organizationId: context.organizationId,
          payload: { name, type: input.type, trackInventory, baseUnit, sku, barcode }, scope: 'catalog_item.create',
        }, async () => { await this.requireOwnerOrAdmin(client, context); });
        if (acquired.kind === 'replay') return { result: this.readStored(acquired.response.body) };
        const organization = await client.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [context.organizationId]);
        if (organization.rowCount !== 1) throw new CatalogItemCreationError('CATALOG_ITEM_CREATION_FORBIDDEN', 'Organización no disponible.');
        let result: CatalogItemResult;
        try {
          const inserted = await client.query<CatalogItemResult>(
            `INSERT INTO catalog_items (id, organization_id, name, type, track_inventory, base_unit, sku, barcode)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, name, type, status, track_inventory AS "trackInventory", base_unit AS "baseUnit",
               sku, barcode, version::integer AS version`,
            [id, context.organizationId, name, input.type, trackInventory, baseUnit, sku, barcode],
          );
          const row = inserted.rows[0];
          if (!row) throw new Error('El ítem no fue persistido.');
          result = row;
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'constraint' in error) {
            const constraint = (error as { constraint?: unknown }).constraint;
            if (constraint === 'catalog_items_organization_sku_norm_key') {
              throw new CatalogItemCreationError('CATALOG_ITEM_SKU_DUPLICATE', 'El SKU ya existe.');
            }
            if (constraint === 'catalog_items_organization_barcode_norm_key') {
              throw new CatalogItemCreationError('CATALOG_ITEM_BARCODE_DUPLICATE', 'El código de barras ya existe.');
            }
          }
          throw error;
        }
        await idempotency.complete(acquired.record.id, { statusCode: 201, body: {
          id: result.id, name: result.name, type: result.type, status: result.status,
          trackInventory: result.trackInventory, baseUnit: result.baseUnit, sku: result.sku,
          barcode: result.barcode, version: result.version,
        } });
        return { result, auditEvent: { action: 'catalog_item.created',
          after: { name, type: input.type, trackInventory, baseUnit, sku, barcode, status: 'ACTIVE' },
          afterAllowlist: ['name', 'type', 'trackInventory', 'baseUnit', 'sku', 'barcode', 'status'],
          before: {}, beforeAllowlist: [], branchId: null, context: {}, contextAllowlist: [],
          entityId: id, entityType: 'catalog_item', operationId: id,
        } };
      });
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError) throw new CatalogItemCreationError('IDEMPOTENCY_KEY_REUSED', error.message);
      if (error instanceof IdempotencyReplayForbiddenError) throw new CatalogItemCreationError('CATALOG_ITEM_CREATION_FORBIDDEN', error.message);
      throw error;
    }
  }

  private readStored(body: unknown): CatalogItemResult {
    if (typeof body === 'object' && body !== null && !Array.isArray(body) &&
      'id' in body && typeof body.id === 'string' && 'name' in body && typeof body.name === 'string' &&
      'type' in body && (body.type === 'PRODUCT' || body.type === 'SERVICE') &&
      'status' in body && body.status === 'ACTIVE' && 'trackInventory' in body && typeof body.trackInventory === 'boolean' &&
      'baseUnit' in body && (body.baseUnit === 'UNIT' || body.baseUnit === 'FRACTIONAL') &&
      'sku' in body && (body.sku === null || typeof body.sku === 'string') &&
      'barcode' in body && (body.barcode === null || typeof body.barcode === 'string') &&
      'version' in body && typeof body.version === 'number') return body as CatalogItemResult;
    throw new Error('Respuesta idempotente de ítem inválida.');
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
      await this.requireOwnerOrAdmin(client, context);
      const result = await client.query<{ name: string }>(
        `SELECT DISTINCT name FROM catalog_items
         WHERE organization_id = $1
           AND (strpos(lower(btrim(name)), lower($2)) > 0
             OR strpos(lower($2), lower(btrim(name))) > 0)
         ORDER BY name
         LIMIT 10`,
        [context.organizationId, trimmed],
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
