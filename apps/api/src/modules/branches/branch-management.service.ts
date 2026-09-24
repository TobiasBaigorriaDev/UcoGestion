import { randomUUID } from 'node:crypto';

import type { DatabaseError, PoolClient } from 'pg';
import { z } from 'zod';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface BranchCreateInput {
  readonly name: string;
}

export interface BranchResult {
  readonly id: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly version: number;
}

export type BranchManagementErrorCode =
  | 'BRANCH_MANAGEMENT_FORBIDDEN'
  | 'BRANCH_NAME_CONFLICT'
  | 'BRANCH_NAME_INVALID';

export class BranchManagementError extends Error {
  constructor(
    readonly code: BranchManagementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BranchManagementError';
  }
}

export class BranchManagementService {
  constructor(private readonly transactions: TenantTransaction) {}

  async create(
    context: TenantTransactionContext,
    input: BranchCreateInput,
    idempotencyKey?: string,
  ): Promise<BranchResult> {
    const branchId = randomUUID();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new BranchManagementError('BRANCH_NAME_INVALID', 'El nombre de la sucursal es obligatorio.');
    }

    try {
      const auditEvent = {
          action: 'branch.created',
          after: { name, status: 'ACTIVE' },
          afterAllowlist: ['name', 'status'],
          before: {},
          beforeAllowlist: [],
          branchId,
          context: {},
          contextAllowlist: [],
          entityId: branchId,
          entityType: 'branch',
          operationId: branchId,
        };
      const operation = async (client: PoolClient) => {
          await this.requireOwner(client, context);
          const inserted = await client.query<BranchResult>(
            `INSERT INTO branches (id, organization_id, name, status)
             VALUES ($1, $2, $3, 'ACTIVE')
             RETURNING id, name, status, version::integer AS version`,
            [branchId, context.organizationId, name],
          );
          const row = inserted.rows.at(0);
          if (!row) throw new Error('La sucursal no fue persistida.');
          return row;
        };
      if (idempotencyKey) {
        return await this.transactions.runIdempotent(context, auditEvent, {
          actorUserId: context.userId, authorizationClass: 'BRANCH_MANAGEMENT', branchId: null,
          key: idempotencyKey, organizationId: context.organizationId, payload: { name }, scope: 'branch.create',
        }, (client) => this.requireOwner(client, context), operation,
        (body) => z.object({ id: z.string(), name: z.string(), status: z.enum(['ACTIVE', 'INACTIVE']), version: z.number().int() }).parse(body));
      }
      return await this.transactions.run(context, auditEvent, operation);
    } catch (error) {
      if ((error as Partial<DatabaseError>).code === '23505') {
        throw new BranchManagementError(
          'BRANCH_NAME_CONFLICT',
          'Ya existe una sucursal con ese nombre en la organización.',
        );
      }
      throw error;
    }
  }

  private async requireOwner(
    client: PoolClient,
    context: TenantTransactionContext,
  ): Promise<void> {
    const membership = await client.query<{ role: string }>(
      `SELECT role FROM memberships
       WHERE organization_id = $1
         AND user_id = $2
         AND status = 'ACTIVE'
         AND revoked_at IS NULL`,
      [context.organizationId, context.userId],
    );
    if (membership.rows.at(0)?.role !== 'OWNER') {
      throw new BranchManagementError(
        'BRANCH_MANAGEMENT_FORBIDDEN',
        'Solo OWNER puede crear una sucursal.',
      );
    }
  }
}
