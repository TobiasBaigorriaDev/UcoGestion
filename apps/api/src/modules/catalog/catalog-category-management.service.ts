import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  IdempotencyKeyReusedError,
  IdempotencyReplayForbiddenError,
  IdempotencyService,
} from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import {
  CategoryLifecycleError,
  CategoryLifecyclePolicy,
  type CategoryLifecycleErrorCode,
  type CategoryStatus,
} from './category-lifecycle.policy.js';
import { PostgresCategoryOfflineExposurePredicate } from './category-offline-exposure.predicate.js';
import { PostgresCategoryServerReferencePredicate } from './category-server-reference.predicate.js';

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
  | CategoryLifecycleErrorCode
  | 'CATALOG_CATEGORY_MANAGEMENT_FORBIDDEN'
  | 'CATALOG_CATEGORY_NAME_INVALID'
  | 'CATALOG_CATEGORY_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'VERSION_CONFLICT';

export class CatalogCategoryManagementError extends Error {
  constructor(
    readonly code: CatalogCategoryManagementErrorCode,
    message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = 'CatalogCategoryManagementError';
  }
}

export class CatalogCategoryManagementService {
  private readonly policy = new CategoryLifecyclePolicy();
  private readonly serverReferences = new PostgresCategoryServerReferencePredicate();
  private readonly offlineExposure = new PostgresCategoryOfflineExposurePredicate();

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

  async changeStatus(
    context: TenantTransactionContext,
    categoryId: string,
    expectedVersion: number,
    targetStatus: CategoryStatus,
    idempotencyKey: string,
  ): Promise<CatalogCategoryResult> {
    this.validateInputs(expectedVersion, idempotencyKey);
    try {
      return await this.transactions.runWithOptionalAudit(context, async (client) => {
        await this.requireOwnerOrAdmin(client, context);

        const idempotency = new IdempotencyService(client);
        const acquired = await idempotency.acquire({
          actorUserId: context.userId,
          authorizationClass: 'OWNER_OR_ADMIN',
          branchId: null,
          key: idempotencyKey,
          organizationId: context.organizationId,
          payload: { categoryId, expectedVersion, targetStatus },
          scope: 'catalog_category.status',
        }, async () => {
          await this.requireOwnerOrAdmin(client, context);
        });

        if (acquired.kind === 'replay') {
          return { result: this.readStoredCategoryResult(acquired.response.body) };
        }

        await this.lockOrganizationEpoch(client, context.organizationId);

        const category = await this.lockCategory(client, context.organizationId, categoryId);
        if (category.version !== expectedVersion) {
          throw new CatalogCategoryManagementError(
            'VERSION_CONFLICT',
            'La categoría fue modificada por otra operación.',
            category.version,
          );
        }

        this.policy.requireStatusTransition({
          currentStatus: category.status,
          targetStatus,
        });

        const updated = await client.query<CatalogCategoryResult>(
          `UPDATE catalog_categories
           SET status = $1, version = version + 1, updated_at = now()
           WHERE organization_id = $2 AND id = $3
           RETURNING id, name, status, version::integer AS version`,
          [targetStatus, context.organizationId, categoryId],
        );
        const result = updated.rows[0];
        if (!result) throw new Error('La categoría de catálogo no pudo ser actualizada.');

        await idempotency.complete(acquired.record.id, {
          statusCode: 200,
          body: {
            id: result.id,
            name: result.name,
            status: result.status,
            version: result.version,
          },
        });

        return {
          result,
          auditEvent: {
            action: 'catalog_category.status_changed',
            after: { status: targetStatus },
            afterAllowlist: ['status'],
            before: { status: category.status },
            beforeAllowlist: ['status'],
            branchId: null,
            context: { categoryId, version: result.version },
            contextAllowlist: ['categoryId', 'version'],
            entityId: categoryId,
            entityType: 'catalog_category',
            operationId: randomUUID(),
          },
        };
      });
    } catch (error) {
      this.handleError(error);
    }
  }

  async deletePhysically(
    context: TenantTransactionContext,
    categoryId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<{ readonly id: string; readonly deleted: true }> {
    this.validateInputs(expectedVersion, idempotencyKey);
    try {
      return await this.transactions.runWithOptionalAudit(context, async (client) => {
        await this.requireOwnerOrAdmin(client, context);

        const idempotency = new IdempotencyService(client);
        const acquired = await idempotency.acquire({
          actorUserId: context.userId,
          authorizationClass: 'OWNER_OR_ADMIN',
          branchId: null,
          key: idempotencyKey,
          organizationId: context.organizationId,
          payload: { categoryId, expectedVersion },
          scope: 'catalog_category.delete',
        }, async () => {
          await this.requireOwnerOrAdmin(client, context);
        });

        if (acquired.kind === 'replay') {
          return { result: { id: categoryId, deleted: true as const } };
        }

        await this.lockOrganizationEpoch(client, context.organizationId);

        const category = await this.lockCategory(client, context.organizationId, categoryId);
        if (category.version !== expectedVersion) {
          throw new CatalogCategoryManagementError(
            'VERSION_CONFLICT',
            'La categoría fue modificada por otra operación.',
            category.version,
          );
        }

        const hasLegacyReferences = await this.serverReferences.check(client, {
          categoryId,
          categoryKind: 'CATALOG',
          organizationId: context.organizationId,
        });

        const generalReferences = await client.query(
          `SELECT 1 FROM resource_history_references
           WHERE organization_id = $1 AND catalog_category_id = $2 LIMIT 1`,
          [context.organizationId, categoryId],
        );
        const hasServerReferences = hasLegacyReferences || (generalReferences.rowCount ?? 0) > 0;

        const offlineSafety = await this.offlineExposure.check(client, {
          categoryId,
          categoryKind: 'CATALOG',
          organizationId: context.organizationId,
        });

        this.policy.requirePhysicalDeletion({
          hasServerReferences,
          offlineSafety,
        });

        await client.query(
          `DELETE FROM catalog_categories WHERE organization_id = $1 AND id = $2`,
          [context.organizationId, categoryId],
        );

        await idempotency.complete(acquired.record.id, {
          statusCode: 200,
          body: { id: categoryId, deleted: true },
        });

        return {
          result: { id: categoryId, deleted: true },
          auditEvent: {
            action: 'catalog_category.deleted',
            after: {},
            afterAllowlist: [],
            before: {
              name: category.name,
              status: category.status,
            },
            beforeAllowlist: ['name', 'status'],
            branchId: null,
            context: { categoryId },
            contextAllowlist: ['categoryId'],
            entityId: categoryId,
            entityType: 'catalog_category',
            operationId: randomUUID(),
          },
        };
      });
    } catch (error) {
      this.handleError(error);
    }
  }

  private async lockOrganizationEpoch(client: PoolClient, organizationId: string): Promise<number> {
    const org = await client.query<{ config_epoch: number }>(
      `SELECT config_epoch::integer AS config_epoch FROM organizations WHERE id = $1 FOR UPDATE`,
      [organizationId],
    );
    const epoch = org.rows[0]?.config_epoch;
    if (epoch === undefined) {
      throw new CatalogCategoryManagementError(
        'CATALOG_CATEGORY_MANAGEMENT_FORBIDDEN',
        'Organización no disponible.',
      );
    }
    return epoch;
  }

  private async lockCategory(
    client: PoolClient,
    organizationId: string,
    categoryId: string,
  ): Promise<CatalogCategoryResult> {
    const result = await client.query<CatalogCategoryResult>(
      `SELECT id, name, status, version::integer AS version
       FROM catalog_categories
       WHERE organization_id = $1 AND id = $2
       FOR UPDATE`,
      [organizationId, categoryId],
    );
    const category = result.rows[0];
    if (!category) {
      throw new CatalogCategoryManagementError(
        'CATALOG_CATEGORY_NOT_FOUND',
        'La categoría de catálogo no existe.',
      );
    }
    return category;
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

  private validateInputs(expectedVersion: number, idempotencyKey: string): void {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
        !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
      throw new CatalogCategoryManagementError('VERSION_CONFLICT', 'Versión o clave idempotente inválida.');
    }
  }

  private readStoredCategoryResult(body: unknown): CatalogCategoryResult {
    if (typeof body === 'object' && body !== null && !Array.isArray(body) &&
        'id' in body && typeof body.id === 'string' &&
        'name' in body && typeof body.name === 'string' &&
        'status' in body && typeof body.status === 'string' &&
        'version' in body && typeof body.version === 'number') {
      return body as CatalogCategoryResult;
    }
    throw new Error('Respuesta idempotente de categoría inválida.');
  }

  private handleError(error: unknown): never {
    if (error instanceof CategoryLifecycleError) {
      throw new CatalogCategoryManagementError(error.code, error.message);
    }
    if (error instanceof IdempotencyKeyReusedError) {
      throw new CatalogCategoryManagementError('IDEMPOTENCY_KEY_REUSED', error.message);
    }
    if (error instanceof IdempotencyReplayForbiddenError) {
      throw new CatalogCategoryManagementError('CATALOG_CATEGORY_MANAGEMENT_FORBIDDEN', error.message);
    }
    throw error;
  }
}
