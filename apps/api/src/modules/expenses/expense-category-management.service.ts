import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError, IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CategoryLifecycleError, CategoryLifecyclePolicy, type CategoryLifecycleErrorCode } from '../catalog/category-lifecycle.policy.js';
import { PostgresCategoryServerReferencePredicate } from '../catalog/category-server-reference.predicate.js';

export interface ExpenseCategoryCreateInput {
  readonly name: string;
}

export interface ExpenseCategoryResult {
  readonly id: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly version: number;
}

export type ExpenseCategoryManagementErrorCode =
  | 'EXPENSE_CATEGORY_MANAGEMENT_FORBIDDEN'
  | 'EXPENSE_CATEGORY_NAME_INVALID'
  | 'EXPENSE_CATEGORY_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | CategoryLifecycleErrorCode;

export class ExpenseCategoryManagementError extends Error {
  constructor(
    readonly code: ExpenseCategoryManagementErrorCode,
    message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = 'ExpenseCategoryManagementError';
  }
}

export class ExpenseCategoryManagementService {
  private readonly lifecycle = new CategoryLifecyclePolicy();
  private readonly references = new PostgresCategoryServerReferencePredicate();
  constructor(private readonly transactions: TenantTransaction) {}

  async list(context: TenantTransactionContext): Promise<ExpenseCategoryResult[]> {
    return this.transactions.read(context, async (client) => {
      await this.requireOwnerOrAdmin(client, context);
      const result = await client.query<ExpenseCategoryResult>(
        `SELECT id, name, status, version::integer AS version FROM expense_categories
         WHERE organization_id = $1 ORDER BY name, id`, [context.organizationId],
      );
      return result.rows;
    });
  }

  async create(
    context: TenantTransactionContext,
    input: ExpenseCategoryCreateInput,
    idempotencyKey?: string,
  ): Promise<ExpenseCategoryResult> {
    const id = randomUUID();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new ExpenseCategoryManagementError(
        'EXPENSE_CATEGORY_NAME_INVALID',
        'El nombre de la categoría de gasto es obligatorio.',
      );
    }
    if (idempotencyKey !== undefined) {
      this.validateKey(idempotencyKey);
      try {
        return await this.transactions.runWithOptionalAudit(context, async (client) => {
          await this.requireOwnerOrAdmin(client, context);
          const idempotency = new IdempotencyService(client);
          const acquired = await idempotency.acquire({ actorUserId: context.userId,
            authorizationClass: 'OWNER_OR_ADMIN', branchId: null, key: idempotencyKey,
            organizationId: context.organizationId, payload: { name }, scope: 'expense_category.create',
          }, async () => { await this.requireOwnerOrAdmin(client, context); });
          if (acquired.kind === 'replay') return { result: this.readStored(acquired.response.body) };
          const inserted = await client.query<ExpenseCategoryResult>(
            `INSERT INTO expense_categories (id, organization_id, name, status)
             VALUES ($1, $2, $3, 'ACTIVE') RETURNING id, name, status, version::integer AS version`,
            [id, context.organizationId, name],
          );
          const result = inserted.rows[0];
          if (!result) throw new Error('La categoría de gasto no fue persistida.');
          await idempotency.complete(acquired.record.id, { statusCode: 201, body: this.jsonResult(result) });
          return { result, auditEvent: { action: 'expense_category.created',
            after: { name, status: 'ACTIVE' }, afterAllowlist: ['name', 'status'],
            before: {}, beforeAllowlist: [], branchId: null, context: {}, contextAllowlist: [],
            entityId: id, entityType: 'expense_category', operationId: id,
          } };
        });
      } catch (error) { this.handleError(error); }
    }
    return this.transactions.run(
      context,
      {
        action: 'expense_category.created',
        after: { name, status: 'ACTIVE' },
        afterAllowlist: ['name', 'status'],
        before: {},
        beforeAllowlist: [],
        branchId: null,
        context: {},
        contextAllowlist: [],
        entityId: id,
        entityType: 'expense_category',
        operationId: id,
      },
      async (client) => {
        await this.requireOwnerOrAdmin(client, context);
        const result = await client.query<ExpenseCategoryResult>(
          `INSERT INTO expense_categories (id, organization_id, name, status)
           VALUES ($1, $2, $3, 'ACTIVE')
           RETURNING id, name, status, version::integer AS version`,
          [id, context.organizationId, name],
        );
        const row = result.rows.at(0);
        if (!row) throw new Error('La categoría de gasto no fue persistida.');
        return row;
      },
    );
  }

  async changeStatus(context: TenantTransactionContext, id: string, version: number,
    status: 'ACTIVE' | 'INACTIVE', key: string): Promise<ExpenseCategoryResult> {
    this.validateVersionAndKey(version, key);
    try {
      return await this.transactions.runWithOptionalAudit(context, async (client) => {
        await this.requireOwnerOrAdmin(client, context);
        const idempotency = new IdempotencyService(client);
        const acquired = await idempotency.acquire({ actorUserId: context.userId,
          authorizationClass: 'OWNER_OR_ADMIN', branchId: null, key,
          organizationId: context.organizationId, payload: { id, version, status }, scope: 'expense_category.status',
        }, async () => { await this.requireOwnerOrAdmin(client, context); });
        if (acquired.kind === 'replay') return { result: this.readStored(acquired.response.body) };
        const category = await this.lockCategory(client, context.organizationId, id);
        if (category.version !== version) throw new ExpenseCategoryManagementError('VERSION_CONFLICT', 'La categoría fue modificada.', category.version);
        this.lifecycle.requireStatusTransition({ currentStatus: category.status, targetStatus: status });
        const updated = await client.query<ExpenseCategoryResult>(
          `UPDATE expense_categories SET status = $1, version = version + 1, updated_at = now()
           WHERE organization_id = $2 AND id = $3 RETURNING id, name, status, version::integer AS version`,
          [status, context.organizationId, id],
        );
        const result = updated.rows[0];
        if (!result) throw new Error('La categoría de gasto no pudo actualizarse.');
        await idempotency.complete(acquired.record.id, { statusCode: 200, body: this.jsonResult(result) });
        return { result, auditEvent: { action: 'expense_category.status_changed',
          after: { status }, afterAllowlist: ['status'], before: { status: category.status },
          beforeAllowlist: ['status'], branchId: null, context: { id, version: result.version },
          contextAllowlist: ['id', 'version'], entityId: id, entityType: 'expense_category', operationId: randomUUID(),
        } };
      });
    } catch (error) { this.handleError(error); }
  }

  async deletePhysically(context: TenantTransactionContext, id: string, version: number,
    key: string): Promise<{ readonly id: string; readonly deleted: true }> {
    this.validateVersionAndKey(version, key);
    try {
      return await this.transactions.runWithOptionalAudit(context, async (client) => {
        await this.requireOwnerOrAdmin(client, context);
        const idempotency = new IdempotencyService(client);
        const acquired = await idempotency.acquire({ actorUserId: context.userId,
          authorizationClass: 'OWNER_OR_ADMIN', branchId: null, key,
          organizationId: context.organizationId, payload: { id, version }, scope: 'expense_category.delete',
        }, async () => { await this.requireOwnerOrAdmin(client, context); });
        if (acquired.kind === 'replay') return { result: { id, deleted: true as const } };
        const category = await this.lockCategory(client, context.organizationId, id);
        if (category.version !== version) throw new ExpenseCategoryManagementError('VERSION_CONFLICT', 'La categoría fue modificada.', category.version);
        const hasReferences = await this.references.check(client, {
          categoryId: id, categoryKind: 'EXPENSE', organizationId: context.organizationId,
        });
        this.lifecycle.requirePhysicalDeletion({ hasServerReferences: hasReferences, offlineSafety: 'BARRIER_CONFIRMED_CLEAR' });
        await client.query('DELETE FROM expense_categories WHERE organization_id = $1 AND id = $2', [context.organizationId, id]);
        await idempotency.complete(acquired.record.id, { statusCode: 200, body: { id, deleted: true } });
        return { result: { id, deleted: true as const }, auditEvent: {
          action: 'expense_category.deleted', after: {}, afterAllowlist: [],
          before: { name: category.name, status: category.status }, beforeAllowlist: ['name', 'status'],
          branchId: null, context: { id }, contextAllowlist: ['id'], entityId: id,
          entityType: 'expense_category', operationId: randomUUID(),
        } };
      });
    } catch (error) { this.handleError(error); }
  }

  private async lockCategory(client: PoolClient, organizationId: string, id: string): Promise<ExpenseCategoryResult> {
    const result = await client.query<ExpenseCategoryResult>(
      `SELECT id, name, status, version::integer AS version FROM expense_categories
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [organizationId, id],
    );
    const category = result.rows[0];
    if (!category) throw new ExpenseCategoryManagementError('EXPENSE_CATEGORY_NOT_FOUND', 'La categoría de gasto no existe.');
    return category;
  }

  private validateKey(key: string): void {
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new ExpenseCategoryManagementError('IDEMPOTENCY_KEY_REUSED', 'Clave idempotente inválida.');
  }

  private validateVersionAndKey(version: number, key: string): void {
    if (!Number.isSafeInteger(version) || version < 1) throw new ExpenseCategoryManagementError('VERSION_CONFLICT', 'Versión inválida.');
    this.validateKey(key);
  }

  private jsonResult(result: ExpenseCategoryResult) {
    return { id: result.id, name: result.name, status: result.status, version: result.version };
  }

  private readStored(body: unknown): ExpenseCategoryResult {
    if (typeof body === 'object' && body !== null && !Array.isArray(body)
      && 'id' in body && typeof body.id === 'string'
      && 'name' in body && typeof body.name === 'string'
      && 'status' in body && (body.status === 'ACTIVE' || body.status === 'INACTIVE')
      && 'version' in body && typeof body.version === 'number') return body as ExpenseCategoryResult;
    throw new Error('Respuesta idempotente de categoría de gasto inválida.');
  }

  private handleError(error: unknown): never {
    if (error instanceof CategoryLifecycleError) throw new ExpenseCategoryManagementError(error.code, error.message);
    if (error instanceof IdempotencyKeyReusedError) throw new ExpenseCategoryManagementError('IDEMPOTENCY_KEY_REUSED', error.message);
    if (error instanceof IdempotencyReplayForbiddenError) throw new ExpenseCategoryManagementError('EXPENSE_CATEGORY_MANAGEMENT_FORBIDDEN', error.message);
    throw error;
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
      throw new ExpenseCategoryManagementError(
        'EXPENSE_CATEGORY_MANAGEMENT_FORBIDDEN',
        'Solo OWNER o ADMIN pueden administrar categorías de gasto.',
      );
    }
  }
}
