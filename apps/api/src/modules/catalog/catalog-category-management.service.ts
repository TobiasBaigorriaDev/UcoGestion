import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface CatalogCategoryCreateInput {
  readonly name: string;
}

export interface CatalogCategoryResult {
  readonly id: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly version: number;
}

export type CatalogCategoryManagementErrorCode =
  | 'CATALOG_CATEGORY_MANAGEMENT_FORBIDDEN'
  | 'CATALOG_CATEGORY_NAME_INVALID';

export class CatalogCategoryManagementError extends Error {
  constructor(
    readonly code: CatalogCategoryManagementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogCategoryManagementError';
  }
}

export class CatalogCategoryManagementService {
  constructor(private readonly transactions: TenantTransaction) {}

  async create(
    context: TenantTransactionContext,
    input: CatalogCategoryCreateInput,
  ): Promise<CatalogCategoryResult> {
    const id = randomUUID();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new CatalogCategoryManagementError(
        'CATALOG_CATEGORY_NAME_INVALID',
        'El nombre de la categoría de catálogo es obligatorio.',
      );
    }
    return this.transactions.run(
      context,
      {
        action: 'catalog_category.created',
        after: { name, status: 'ACTIVE' },
        afterAllowlist: ['name', 'status'],
        before: {},
        beforeAllowlist: [],
        branchId: null,
        context: {},
        contextAllowlist: [],
        entityId: id,
        entityType: 'catalog_category',
        operationId: id,
      },
      async (client) => {
        await this.requireOwnerOrAdmin(client, context);
        const result = await client.query<CatalogCategoryResult>(
          `INSERT INTO catalog_categories (id, organization_id, name, status)
           VALUES ($1, $2, $3, 'ACTIVE')
           RETURNING id, name, status, version::integer AS version`,
          [id, context.organizationId, name],
        );
        const row = result.rows.at(0);
        if (!row) throw new Error('La categoría de catálogo no fue persistida.');
        return row;
      },
    );
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
      throw new CatalogCategoryManagementError(
        'CATALOG_CATEGORY_MANAGEMENT_FORBIDDEN',
        'Solo OWNER o ADMIN pueden administrar categorías de catálogo.',
      );
    }
  }
}
