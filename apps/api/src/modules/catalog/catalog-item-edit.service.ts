import { randomUUID } from 'node:crypto';

import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError, IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export type ItemEditInput = Readonly<{ name: string; sku: string | null; barcode: string | null }>;
export type ItemEditResult = Readonly<{ id: string; name: string; sku: string | null; barcode: string | null; version: number }>;

export class CatalogItemEditError extends Error {
  constructor(readonly code: 'CATALOG_ITEM_EDIT_FORBIDDEN' | 'CATALOG_ITEM_NOT_FOUND' |
    'CATALOG_ITEM_NAME_INVALID' | 'CATALOG_ITEM_SKU_DUPLICATE' | 'CATALOG_ITEM_BARCODE_DUPLICATE' |
    'VERSION_CONFLICT' | 'IDEMPOTENCY_KEY_REUSED', message: string, readonly currentVersion?: number) {
    super(message);
    this.name = 'CatalogItemEditError';
  }
}

export class CatalogItemEditService {
  constructor(private readonly transactions: TenantTransaction) {}

  async update(context: TenantTransactionContext, id: string, version: number,
    input: ItemEditInput, key: string): Promise<ItemEditResult> {
    if (!Number.isSafeInteger(version) || version < 1) throw new CatalogItemEditError('VERSION_CONFLICT', 'Versión inválida.');
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new CatalogItemEditError('IDEMPOTENCY_KEY_REUSED', 'Clave idempotente inválida.');
    const name = input.name.trim();
    if (!name) throw new CatalogItemEditError('CATALOG_ITEM_NAME_INVALID', 'El nombre es obligatorio.');
    const sku = input.sku?.trim() || null;
    const barcode = input.barcode?.trim() || null;
    try {
      return await this.transactions.runWithOptionalAudit(context, async (client) => {
        const actor = await client.query<{ role: string }>(
          `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2
           AND status = 'ACTIVE' AND revoked_at IS NULL`, [context.organizationId, context.userId],
        );
        if (!['OWNER', 'ADMIN'].includes(actor.rows[0]?.role ?? '')) {
          throw new CatalogItemEditError('CATALOG_ITEM_EDIT_FORBIDDEN', 'Solo OWNER o ADMIN pueden editar ítems.');
        }
        const idempotency = new IdempotencyService(client);
        const acquired = await idempotency.acquire({ actorUserId: context.userId,
          authorizationClass: 'OWNER_OR_ADMIN', branchId: null, key,
          organizationId: context.organizationId, payload: { id, version, name, sku, barcode },
          scope: 'catalog_item.edit',
        }, async () => {
          const renewed = await client.query<{ role: string }>(
            `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2
             AND status = 'ACTIVE' AND revoked_at IS NULL`, [context.organizationId, context.userId],
          );
          if (!['OWNER', 'ADMIN'].includes(renewed.rows[0]?.role ?? '')) {
            throw new CatalogItemEditError('CATALOG_ITEM_EDIT_FORBIDDEN', 'Permiso revocado.');
          }
        });
        if (acquired.kind === 'replay') return { result: this.readStored(acquired.response.body) };
        const current = await client.query<ItemEditResult>(
          `SELECT id, name, sku, barcode, version::integer AS version FROM catalog_items
           WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [context.organizationId, id],
        );
        const item = current.rows[0];
        if (!item) throw new CatalogItemEditError('CATALOG_ITEM_NOT_FOUND', 'El ítem no existe.');
        if (item.version !== version) throw new CatalogItemEditError('VERSION_CONFLICT', 'El ítem fue modificado.', item.version);
        let result: ItemEditResult;
        try {
          const updated = await client.query<ItemEditResult>(
            `UPDATE catalog_items SET name = $1, sku = $2, barcode = $3, version = version + 1, updated_at = now()
             WHERE organization_id = $4 AND id = $5
             RETURNING id, name, sku, barcode, version::integer AS version`,
            [name, sku, barcode, context.organizationId, id],
          );
          const row = updated.rows[0];
          if (!row) throw new Error('El ítem no pudo actualizarse.');
          result = row;
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'constraint' in error) {
            const constraint = (error as { constraint?: unknown }).constraint;
            if (constraint === 'catalog_items_organization_sku_norm_key') throw new CatalogItemEditError('CATALOG_ITEM_SKU_DUPLICATE', 'El SKU ya existe.');
            if (constraint === 'catalog_items_organization_barcode_norm_key') throw new CatalogItemEditError('CATALOG_ITEM_BARCODE_DUPLICATE', 'El código de barras ya existe.');
          }
          throw error;
        }
        await idempotency.complete(acquired.record.id, { statusCode: 200, body: {
          id: result.id, name: result.name, sku: result.sku, barcode: result.barcode, version: result.version,
        } });
        return { result, auditEvent: { action: 'catalog_item.edited',
          after: { name, sku, barcode }, afterAllowlist: ['name', 'sku', 'barcode'],
          before: { name: item.name, sku: item.sku, barcode: item.barcode }, beforeAllowlist: ['name', 'sku', 'barcode'],
          branchId: null, context: { version: result.version }, contextAllowlist: ['version'],
          entityId: id, entityType: 'catalog_item', operationId: randomUUID(),
        } };
      });
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError) throw new CatalogItemEditError('IDEMPOTENCY_KEY_REUSED', error.message);
      if (error instanceof IdempotencyReplayForbiddenError) throw new CatalogItemEditError('CATALOG_ITEM_EDIT_FORBIDDEN', error.message);
      throw error;
    }
  }

  private readStored(body: unknown): ItemEditResult {
    if (typeof body === 'object' && body !== null && !Array.isArray(body)
      && 'id' in body && typeof body.id === 'string'
      && 'name' in body && typeof body.name === 'string'
      && 'sku' in body && (body.sku === null || typeof body.sku === 'string')
      && 'barcode' in body && (body.barcode === null || typeof body.barcode === 'string')
      && 'version' in body && typeof body.version === 'number') {
      return { id: body.id, name: body.name, sku: body.sku, barcode: body.barcode, version: body.version };
    }
    throw new Error('Respuesta idempotente de edición de ítem inválida.');
  }
}
