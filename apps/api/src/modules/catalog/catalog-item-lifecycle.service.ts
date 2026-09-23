import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  IdempotencyKeyReusedError,
  IdempotencyReplayForbiddenError,
  IdempotencyService,
} from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { ResourceSafetyService } from '../offline-sync/resource-safety.service.js';
import {
  CatalogItemLifecycleError,
  CatalogItemLifecyclePolicy,
  type CatalogItemBaseUnit,
  type CatalogItemLifecycleErrorCode,
  type CatalogItemStatus,
  type CatalogItemType,
} from './catalog-item-lifecycle.policy.js';

export interface CatalogItemLifecycleResult {
  readonly barcode: string | null;
  readonly baseUnit: CatalogItemBaseUnit;
  readonly id: string;
  readonly name: string;
  readonly sku: string | null;
  readonly status: CatalogItemStatus;
  readonly trackInventory: boolean;
  readonly type: CatalogItemType;
  readonly version: number;
}

export type CatalogItemServiceErrorCode =
  | CatalogItemLifecycleErrorCode
  | 'CATALOG_ITEM_LIFECYCLE_FORBIDDEN'
  | 'CATALOG_ITEM_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'VERSION_CONFLICT';

export class CatalogItemServiceError extends Error {
  constructor(
    readonly code: CatalogItemServiceErrorCode,
    message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = 'CatalogItemServiceError';
  }
}

export class CatalogItemLifecycleService {
  private readonly policy = new CatalogItemLifecyclePolicy();
  private readonly safety: ResourceSafetyService;

  constructor(private readonly transactions: TenantTransaction) {
    this.safety = new ResourceSafetyService(transactions);
  }

  async changeStatus(
    context: TenantTransactionContext,
    itemId: string,
    expectedVersion: number,
    targetStatus: CatalogItemStatus,
    idempotencyKey: string,
  ): Promise<CatalogItemLifecycleResult> {
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
          payload: { expectedVersion, itemId, targetStatus },
          scope: 'catalog_item.status',
        }, async () => {
          await this.requireOwnerOrAdmin(client, context);
        });

        if (acquired.kind === 'replay') {
          return { result: this.readStoredItemResult(acquired.response.body) };
        }

        await this.lockOrganizationEpoch(client, context.organizationId);

        const item = await this.lockItem(client, context.organizationId, itemId);
        if (item.version !== expectedVersion) {
          throw new CatalogItemServiceError(
            'VERSION_CONFLICT',
            'El ítem fue modificado por otra operación.',
            item.version,
          );
        }

        this.policy.requireStatusTransition({
          currentStatus: item.status,
          targetStatus,
        });

        const updated = await client.query<CatalogItemLifecycleResult>(
          `UPDATE catalog_items
           SET status = $1, version = version + 1, updated_at = now()
           WHERE organization_id = $2 AND id = $3
           RETURNING id, name, status, track_inventory AS "trackInventory", base_unit AS "baseUnit",
             sku, barcode, type, version::integer AS version`,
          [targetStatus, context.organizationId, itemId],
        );
        const result = updated.rows[0];
        if (!result) throw new Error('El ítem de catálogo no pudo ser actualizado.');
        await this.advanceOrganizationEpoch(client, context.organizationId);

        await idempotency.complete(acquired.record.id, {
          statusCode: 200,
          body: {
            barcode: result.barcode,
            baseUnit: result.baseUnit,
            id: result.id,
            name: result.name,
            sku: result.sku,
            status: result.status,
            trackInventory: result.trackInventory,
            type: result.type,
            version: result.version,
          },
        });

        return {
          result,
          auditEvent: {
            action: 'catalog_item.status_changed',
            after: { status: targetStatus },
            afterAllowlist: ['status'],
            before: { status: item.status },
            beforeAllowlist: ['status'],
            branchId: null,
            context: { itemId, version: result.version },
            contextAllowlist: ['itemId', 'version'],
            entityId: itemId,
            entityType: 'catalog_item',
            operationId: randomUUID(),
          },
        };
      });
    } catch (error) {
      this.handleError(error);
    }
  }

  async changeStructural(
    context: TenantTransactionContext,
    itemId: string,
    expectedVersion: number,
    target: {
      readonly type: CatalogItemType;
      readonly trackInventory?: boolean;
      readonly baseUnit?: CatalogItemBaseUnit;
    },
    idempotencyKey: string,
  ): Promise<CatalogItemLifecycleResult> {
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
          payload: { expectedVersion, itemId, target },
          scope: 'catalog_item.structural',
        }, async () => {
          await this.requireOwnerOrAdmin(client, context);
        });

        if (acquired.kind === 'replay') {
          return { result: this.readStoredItemResult(acquired.response.body) };
        }

        await this.lockOrganizationEpoch(client, context.organizationId);

        const item = await this.lockItem(client, context.organizationId, itemId);
        if (item.version !== expectedVersion) {
          throw new CatalogItemServiceError(
            'VERSION_CONFLICT',
            'El ítem fue modificado por otra operación.',
            item.version,
          );
        }

        const barrier = await client.query(
          `SELECT 1 FROM configuration_barriers WHERE organization_id = $1 AND status = 'ACTIVE'`,
          [context.organizationId],
        );
        const barrierActive = (barrier.rowCount ?? 0) > 0;

        const safety = await this.safety.resourceInTransaction(client, context.organizationId, {
          kind: 'CATALOG_ITEM',
          id: itemId,
        });

        const validated = this.policy.requireStructuralChange({
          barrierActive,
          current: {
            baseUnit: item.baseUnit,
            trackInventory: item.trackInventory,
            type: item.type,
          },
          hasServerReferences: safety === 'HISTORY',
          offlineSafety: safety,
          target: {
            baseUnit: target.baseUnit ?? item.baseUnit,
            trackInventory: target.trackInventory !== undefined
              ? target.trackInventory
              : (target.type === 'SERVICE' ? false : item.trackInventory),
            type: target.type,
          },
        });

        const updated = await client.query<CatalogItemLifecycleResult>(
          `UPDATE catalog_items
           SET type = $1, track_inventory = $2, base_unit = $3, version = version + 1, updated_at = now()
           WHERE organization_id = $4 AND id = $5
           RETURNING id, name, status, track_inventory AS "trackInventory", base_unit AS "baseUnit",
             sku, barcode, type, version::integer AS version`,
          [validated.type, validated.trackInventory, validated.baseUnit, context.organizationId, itemId],
        );
        const result = updated.rows[0];
        if (!result) throw new Error('El ítem de catálogo no pudo ser actualizado.');
        await this.advanceOrganizationEpoch(client, context.organizationId);

        await idempotency.complete(acquired.record.id, {
          statusCode: 200,
          body: {
            barcode: result.barcode,
            baseUnit: result.baseUnit,
            id: result.id,
            name: result.name,
            sku: result.sku,
            status: result.status,
            trackInventory: result.trackInventory,
            type: result.type,
            version: result.version,
          },
        });

        return {
          result,
          auditEvent: {
            action: 'catalog_item.structural_changed',
            after: {
              baseUnit: validated.baseUnit,
              trackInventory: validated.trackInventory,
              type: validated.type,
            },
            afterAllowlist: ['baseUnit', 'trackInventory', 'type'],
            before: {
              baseUnit: item.baseUnit,
              trackInventory: item.trackInventory,
              type: item.type,
            },
            beforeAllowlist: ['baseUnit', 'trackInventory', 'type'],
            branchId: null,
            context: { itemId, version: result.version },
            contextAllowlist: ['itemId', 'version'],
            entityId: itemId,
            entityType: 'catalog_item',
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
    itemId: string,
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
          payload: { expectedVersion, itemId },
          scope: 'catalog_item.delete',
        }, async () => {
          await this.requireOwnerOrAdmin(client, context);
        });

        if (acquired.kind === 'replay') {
          return { result: { id: itemId, deleted: true as const } };
        }

        await this.lockOrganizationEpoch(client, context.organizationId);

        const item = await this.lockItem(client, context.organizationId, itemId);
        if (item.version !== expectedVersion) {
          throw new CatalogItemServiceError(
            'VERSION_CONFLICT',
            'El ítem fue modificado por otra operación.',
            item.version,
          );
        }

        const barrier = await client.query(
          `SELECT 1 FROM configuration_barriers WHERE organization_id = $1 AND status = 'ACTIVE'`,
          [context.organizationId],
        );
        if ((barrier.rowCount ?? 0) > 0) {
          throw new CatalogItemLifecycleError(
            'CATALOG_ITEM_DELETE_BLOCKED_BY_OFFLINE_UNCERTAINTY',
            'Hay una barrera de configuración activa en curso.',
          );
        }

        const safety = await this.safety.resourceInTransaction(client, context.organizationId, {
          kind: 'CATALOG_ITEM',
          id: itemId,
        });

        const priceVersions = await client.query(
          `SELECT 1 FROM catalog_price_versions WHERE organization_id = $1 AND item_id = $2 LIMIT 1`,
          [context.organizationId, itemId],
        );

        this.policy.requirePhysicalDeletion({
          hasServerReferences: safety === 'HISTORY' || (priceVersions.rowCount ?? 0) > 0,
          offlineSafety: safety,
        });

        await client.query(
          `DELETE FROM catalog_items WHERE organization_id = $1 AND id = $2`,
          [context.organizationId, itemId],
        );
        await this.advanceOrganizationEpoch(client, context.organizationId);

        await idempotency.complete(acquired.record.id, {
          statusCode: 200,
          body: { id: itemId, deleted: true },
        });

        return {
          result: { id: itemId, deleted: true },
          auditEvent: {
            action: 'catalog_item.deleted',
            after: {},
            afterAllowlist: [],
            before: {
              name: item.name,
              status: item.status,
              type: item.type,
            },
            beforeAllowlist: ['name', 'status', 'type'],
            branchId: null,
            context: { itemId },
            contextAllowlist: ['itemId'],
            entityId: itemId,
            entityType: 'catalog_item',
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
      throw new CatalogItemServiceError('CATALOG_ITEM_LIFECYCLE_FORBIDDEN', 'Organización no disponible.');
    }
    return epoch;
  }

  private async advanceOrganizationEpoch(client: PoolClient, organizationId: string): Promise<void> {
    await client.query('UPDATE organizations SET config_epoch = config_epoch + 1 WHERE id = $1', [organizationId]);
  }

  private async lockItem(
    client: PoolClient,
    organizationId: string,
    itemId: string,
  ): Promise<CatalogItemLifecycleResult> {
    const result = await client.query<CatalogItemLifecycleResult>(
      `SELECT id, name, status, track_inventory AS "trackInventory", base_unit AS "baseUnit",
         sku, barcode, type, version::integer AS version
       FROM catalog_items
       WHERE organization_id = $1 AND id = $2
       FOR UPDATE`,
      [organizationId, itemId],
    );
    const item = result.rows[0];
    if (!item) {
      throw new CatalogItemServiceError('CATALOG_ITEM_NOT_FOUND', 'El ítem de catálogo no existe.');
    }
    return item;
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
    if (!['OWNER', 'ADMIN'].includes(membership.rows[0]?.role ?? '')) {
      throw new CatalogItemServiceError(
        'CATALOG_ITEM_LIFECYCLE_FORBIDDEN',
        'Solo OWNER o ADMIN pueden administrar el ciclo de vida de los ítems.',
      );
    }
  }

  private validateInputs(expectedVersion: number, idempotencyKey: string): void {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
        !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
      throw new CatalogItemServiceError('VERSION_CONFLICT', 'Versión o clave idempotente inválida.');
    }
  }

  private readStoredItemResult(body: unknown): CatalogItemLifecycleResult {
    if (typeof body === 'object' && body !== null && !Array.isArray(body) &&
        'id' in body && typeof body.id === 'string' &&
        'name' in body && typeof body.name === 'string' &&
        'status' in body && typeof body.status === 'string' &&
        'version' in body && typeof body.version === 'number') {
      return body as CatalogItemLifecycleResult;
    }
    throw new Error('Respuesta idempotente de ítem inválida.');
  }

  private handleError(error: unknown): never {
    if (error instanceof CatalogItemLifecycleError) {
      throw new CatalogItemServiceError(error.code, error.message);
    }
    if (error instanceof IdempotencyKeyReusedError) {
      throw new CatalogItemServiceError('IDEMPOTENCY_KEY_REUSED', error.message);
    }
    if (error instanceof IdempotencyReplayForbiddenError) {
      throw new CatalogItemServiceError('CATALOG_ITEM_LIFECYCLE_FORBIDDEN', error.message);
    }
    throw error;
  }
}
