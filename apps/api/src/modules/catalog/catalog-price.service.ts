import { randomUUID } from 'node:crypto';

import { Money, validateNonNegativeMoney } from '@uconext/shared';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export type CatalogPriceErrorCode =
  | 'CATALOG_PRICE_FORBIDDEN'
  | 'CATALOG_PRICE_INVALID'
  | 'CATALOG_PRICE_ITEM_NOT_FOUND'
  | 'VERSION_CONFLICT';

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
}
