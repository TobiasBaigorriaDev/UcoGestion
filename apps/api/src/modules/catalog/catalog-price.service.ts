import { randomUUID } from 'node:crypto';

import { Money, validateNonNegativeMoney } from '@uconext/shared';

import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError, IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export type CatalogPriceErrorCode =
  | 'CATALOG_PRICE_FORBIDDEN'
  | 'CATALOG_PRICE_INVALID'
  | 'CATALOG_PRICE_ITEM_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED';

export class CatalogPriceError extends Error {
  constructor(readonly code: CatalogPriceErrorCode, message: string) {
    super(message);
    this.name = 'CatalogPriceError';
  }
}

export interface CatalogPriceResult {
  readonly currency: string;
  readonly itemId: string;
  readonly price: string;
  readonly priceVersion: number;
  readonly version: number;
}

export class CatalogPriceService {
  constructor(private readonly transactions: TenantTransaction) {}

  async setPrice(
    context: TenantTransactionContext,
    itemId: string,
    expectedVersion: number,
    rawPrice: string,
  ): Promise<CatalogPriceResult> {
    let price: string;
    try {
      price = Money.from(rawPrice).toString();
    } catch {
      throw new CatalogPriceError('CATALOG_PRICE_INVALID', 'El precio debe ser un decimal válido.');
    }
    if (validateNonNegativeMoney(price) === undefined || !/^(?:0|[1-9]\d{0,17})\.\d{2}$/.test(price)) {
      throw new CatalogPriceError('CATALOG_PRICE_INVALID', 'El precio debe ser no negativo y caber en numeric(20,2).');
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new CatalogPriceError('VERSION_CONFLICT', 'La versión esperada es inválida.');
    }

    return this.transactions.run(
      context,
      {
        action: 'catalog_item.price_changed',
        after: { price },
        afterAllowlist: ['price'],
        before: {},
        beforeAllowlist: [],
        branchId: null,
        context: { expectedVersion },
        contextAllowlist: ['expectedVersion'],
        entityId: itemId,
        entityType: 'catalog_item',
        operationId: randomUUID(),
      },
      async (client) => {
        const membership = await client.query<{ role: string }>(
          `SELECT role FROM memberships
           WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE' AND revoked_at IS NULL`,
          [context.organizationId, context.userId],
        );
        if (!['OWNER', 'ADMIN'].includes(membership.rows[0]?.role ?? '')) {
          throw new CatalogPriceError('CATALOG_PRICE_FORBIDDEN', 'Solo OWNER o ADMIN pueden cambiar precios.');
        }

        const organization = await client.query<{ base_currency: string }>(
          'SELECT base_currency FROM organizations WHERE id = $1 FOR UPDATE',
          [context.organizationId],
        );
        const currency = organization.rows[0]?.base_currency;
        if (!currency) {
          throw new CatalogPriceError('CATALOG_PRICE_FORBIDDEN', 'La organización no está disponible.');
        }

        const item = await client.query<{ version: number; price_version: number }>(
          `SELECT version::integer AS version, price_version::integer AS price_version
           FROM catalog_items WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [context.organizationId, itemId],
        );
        const current = item.rows[0];
        if (!current) {
          throw new CatalogPriceError('CATALOG_PRICE_ITEM_NOT_FOUND', 'El ítem no existe en esta organización.');
        }
        if (current.version !== expectedVersion) {
          throw new CatalogPriceError('VERSION_CONFLICT', 'El ítem fue modificado por otra operación.');
        }

        const priceVersion = current.price_version + 1;
        const priceVersionId = randomUUID();
        await client.query(
          `INSERT INTO catalog_price_versions
             (id, organization_id, item_id, price_version, price, currency)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [priceVersionId, context.organizationId, itemId, priceVersion, price, currency],
        );
        await client.query(
          `INSERT INTO organization_history_references
             (id, organization_id, reference_domain, reference_type, source_id)
           VALUES ($1, $2, 'MONETARY', 'CATALOG_PRICE_VERSION', $3)`,
          [randomUUID(), context.organizationId, priceVersionId],
        );
        const updated = await client.query<{ version: number }>(
          `UPDATE catalog_items
           SET price = $1, price_version = $2, version = version + 1, updated_at = now()
           WHERE organization_id = $3 AND id = $4
           RETURNING version::integer AS version`,
          [price, priceVersion, context.organizationId, itemId],
        );
        const version = updated.rows[0]?.version;
        if (version === undefined) throw new Error('El precio no fue persistido.');
        return { currency, itemId, price, priceVersion, version };
      },
    );
  }

  async setPriceIdempotent(context: TenantTransactionContext, itemId: string,
    expectedVersion: number, rawPrice: string, key: string): Promise<CatalogPriceResult> {
    let price: string;
    try { price = Money.from(rawPrice).toString(); }
    catch { throw new CatalogPriceError('CATALOG_PRICE_INVALID', 'El precio debe ser un decimal válido.'); }
    if (validateNonNegativeMoney(price) === undefined || !/^(?:0|[1-9]\d{0,17})\.\d{2}$/.test(price)) {
      throw new CatalogPriceError('CATALOG_PRICE_INVALID', 'El precio debe ser no negativo.');
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new CatalogPriceError('VERSION_CONFLICT', 'Versión inválida.');
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new CatalogPriceError('IDEMPOTENCY_KEY_REUSED', 'Clave idempotente inválida.');
    try {
      return await this.transactions.runWithOptionalAudit(context, async (client) => {
        const authorize = async () => {
          const membership = await client.query<{ role: string }>(
            `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2
             AND status = 'ACTIVE' AND revoked_at IS NULL`, [context.organizationId, context.userId],
          );
          if (!['OWNER', 'ADMIN'].includes(membership.rows[0]?.role ?? '')) {
            throw new CatalogPriceError('CATALOG_PRICE_FORBIDDEN', 'Solo OWNER o ADMIN pueden cambiar precios.');
          }
        };
        await authorize();
        const idempotency = new IdempotencyService(client);
        const acquired = await idempotency.acquire({ actorUserId: context.userId,
          authorizationClass: 'OWNER_OR_ADMIN', branchId: null, key,
          organizationId: context.organizationId,
          payload: { itemId, expectedVersion, price }, scope: 'catalog_item.price',
        }, authorize);
        if (acquired.kind === 'replay') {
          const body = acquired.response.body;
          if (typeof body !== 'object' || body === null || !('price' in body) || typeof body.price !== 'string'
            || !('itemId' in body) || typeof body.itemId !== 'string'
            || !('currency' in body) || typeof body.currency !== 'string'
            || !('priceVersion' in body) || typeof body.priceVersion !== 'number'
            || !('version' in body) || typeof body.version !== 'number') throw new Error('Respuesta idempotente de precio inválida.');
          return { result: { price: body.price, itemId: body.itemId, currency: body.currency,
            priceVersion: body.priceVersion, version: body.version } };
        }
        const organization = await client.query<{ base_currency: string }>(
          'SELECT base_currency FROM organizations WHERE id = $1 FOR UPDATE', [context.organizationId],
        );
        const currency = organization.rows[0]?.base_currency;
        if (!currency) throw new CatalogPriceError('CATALOG_PRICE_FORBIDDEN', 'Organización no disponible.');
        const item = await client.query<{ version: number; price_version: number }>(
          `SELECT version::integer AS version, price_version::integer AS price_version
           FROM catalog_items WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [context.organizationId, itemId],
        );
        const current = item.rows[0];
        if (!current) throw new CatalogPriceError('CATALOG_PRICE_ITEM_NOT_FOUND', 'El ítem no existe.');
        if (current.version !== expectedVersion) throw new CatalogPriceError('VERSION_CONFLICT', 'El ítem fue modificado.');
        const priceVersion = current.price_version + 1;
        const priceVersionId = randomUUID();
        await client.query(`INSERT INTO catalog_price_versions
          (id, organization_id, item_id, price_version, price, currency)
          VALUES ($1, $2, $3, $4, $5, $6)`,
        [priceVersionId, context.organizationId, itemId, priceVersion, price, currency]);
        await client.query(`INSERT INTO organization_history_references
          (id, organization_id, reference_domain, reference_type, source_id)
          VALUES ($1, $2, 'MONETARY', 'CATALOG_PRICE_VERSION', $3)`,
        [randomUUID(), context.organizationId, priceVersionId]);
        const updated = await client.query<{ version: number }>(
          `UPDATE catalog_items SET price = $1, price_version = $2, version = version + 1, updated_at = now()
           WHERE organization_id = $3 AND id = $4 RETURNING version::integer AS version`,
          [price, priceVersion, context.organizationId, itemId],
        );
        const version = updated.rows[0]?.version;
        if (version === undefined) throw new Error('El precio no fue persistido.');
        const result = { currency, itemId, price, priceVersion, version };
        await idempotency.complete(acquired.record.id, { statusCode: 200, body: result });
        return { result, auditEvent: { action: 'catalog_item.price_changed',
          after: { price }, afterAllowlist: ['price'], before: {}, beforeAllowlist: [],
          branchId: null, context: { expectedVersion }, contextAllowlist: ['expectedVersion'],
          entityId: itemId, entityType: 'catalog_item', operationId: randomUUID(),
        } };
      });
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError) throw new CatalogPriceError('IDEMPOTENCY_KEY_REUSED', error.message);
      if (error instanceof IdempotencyReplayForbiddenError) throw new CatalogPriceError('CATALOG_PRICE_FORBIDDEN', error.message);
      throw error;
    }
  }
}
