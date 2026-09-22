import { randomUUID } from 'node:crypto';

import type { DatabaseError, PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface CashRegisterCreateInput {
  readonly branchId: string;
  readonly name: string;
}

export interface CashRegisterRenameInput {
  readonly expectedVersion: number;
  readonly name: string;
}

export interface CashRegisterResult {
  readonly branchId: string;
  readonly id: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly version: number;
}

export type CashRegisterManagementErrorCode =
  | 'CASH_REGISTER_BRANCH_FORBIDDEN'
  | 'CASH_REGISTER_BRANCH_NOT_AVAILABLE'
  | 'CASH_REGISTER_MANAGEMENT_FORBIDDEN'
  | 'CASH_REGISTER_NAME_CONFLICT'
  | 'CASH_REGISTER_NAME_INVALID'
  | 'CASH_REGISTER_NOT_AVAILABLE'
  | 'CASH_REGISTER_VERSION_CONFLICT';

export class CashRegisterManagementError extends Error {
  constructor(
    readonly code: CashRegisterManagementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CashRegisterManagementError';
  }
}

interface ActorMembership {
  readonly id: string;
  readonly role: string;
}

export class CashRegisterManagementService {
  constructor(private readonly transactions: TenantTransaction) {}

  async create(
    context: TenantTransactionContext,
    input: CashRegisterCreateInput,
  ): Promise<CashRegisterResult> {
    const id = randomUUID();
    const name = normalizeName(input.name);
    try {
      return await this.transactions.run(
        context,
        this.auditEvent('cash_register.created', id, input.branchId, { name, status: 'ACTIVE' }),
        async (client) => {
          await this.requireAuthorizedBranch(client, context, input.branchId);
          const result = await client.query<CashRegisterResult>(
            `INSERT INTO cash_registers (id, organization_id, branch_id, name, status)
             VALUES ($1, $2, $3, $4, 'ACTIVE')
             RETURNING id, branch_id AS "branchId", name, status, version::integer AS version`,
            [id, context.organizationId, input.branchId, name],
          );
          const row = result.rows.at(0);
          if (!row) throw new Error('La caja no fue persistida.');
          return row;
        },
      );
    } catch (error) {
      if ((error as Partial<DatabaseError>).code === '23505') {
        throw new CashRegisterManagementError(
          'CASH_REGISTER_NAME_CONFLICT',
          'Ya existe una caja con ese nombre en la sucursal.',
        );
      }
      throw error;
    }
  }

  async rename(
    context: TenantTransactionContext,
    cashRegisterId: string,
    input: CashRegisterRenameInput,
  ): Promise<CashRegisterResult> {
    const name = normalizeName(input.name);
    try {
      return await this.transactions.run(
        context,
        this.auditEvent('cash_register.renamed', cashRegisterId, null, { name }),
        async (client) => {
          const register = await client.query<{ branchId: string }>(
            `SELECT branch_id AS "branchId" FROM cash_registers
             WHERE organization_id = $1 AND id = $2
             FOR UPDATE`,
            [context.organizationId, cashRegisterId],
          );
          const branchId = register.rows.at(0)?.branchId;
          if (!branchId) {
            throw new CashRegisterManagementError(
              'CASH_REGISTER_NOT_AVAILABLE',
              'La caja no está disponible en la organización.',
            );
          }
          await this.requireAuthorizedBranch(client, context, branchId);
          const updated = await client.query<CashRegisterResult>(
            `UPDATE cash_registers
             SET name = $1, version = version + 1
             WHERE organization_id = $2 AND id = $3 AND version = $4
             RETURNING id, branch_id AS "branchId", name, status, version::integer AS version`,
            [name, context.organizationId, cashRegisterId, input.expectedVersion],
          );
          const row = updated.rows.at(0);
          if (!row) {
            throw new CashRegisterManagementError(
              'CASH_REGISTER_VERSION_CONFLICT',
              'La caja fue modificada por otra operación.',
            );
          }
          return row;
        },
      );
    } catch (error) {
      if ((error as Partial<DatabaseError>).code === '23505') {
        throw new CashRegisterManagementError(
          'CASH_REGISTER_NAME_CONFLICT',
          'Ya existe una caja con ese nombre en la sucursal.',
        );
      }
      throw error;
    }
  }

  async deactivate(
    context: TenantTransactionContext,
    cashRegisterId: string,
    expectedVersion: number,
  ): Promise<CashRegisterResult> {
    return this.transactions.run(
      context,
      this.auditEvent('cash_register.deactivated', cashRegisterId, null, { status: 'INACTIVE' }),
      async (client) => {
        const register = await client.query<{ branchId: string; status: string }>(
          `SELECT branch_id AS "branchId", status FROM cash_registers
           WHERE organization_id = $1 AND id = $2
           FOR UPDATE`,
          [context.organizationId, cashRegisterId],
        );
        const current = register.rows.at(0);
        if (!current) {
          throw new CashRegisterManagementError(
            'CASH_REGISTER_NOT_AVAILABLE',
            'La caja no está disponible en la organización.',
          );
        }
        await this.requireAuthorizedBranch(client, context, current.branchId);
        const updated = await client.query<CashRegisterResult>(
          `UPDATE cash_registers
           SET status = 'INACTIVE', version = version + 1
           WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE' AND version = $3
           RETURNING id, branch_id AS "branchId", name, status, version::integer AS version`,
          [context.organizationId, cashRegisterId, expectedVersion],
        );
        const row = updated.rows.at(0);
        if (!row) {
          throw new CashRegisterManagementError(
            'CASH_REGISTER_VERSION_CONFLICT',
            'La caja cambió de estado o fue modificada por otra operación.',
          );
        }
        return row;
      },
    );
  }

  private auditEvent(
    action: string,
    entityId: string,
    branchId: string | null,
    after: Record<string, string>,
  ) {
    return {
      action,
      after,
      afterAllowlist: Object.keys(after),
      before: {},
      beforeAllowlist: [],
      branchId,
      context: {},
      contextAllowlist: [],
      entityId,
      entityType: 'cash_register',
      operationId: entityId,
    };
  }

  private async requireAuthorizedBranch(
    client: PoolClient,
    context: TenantTransactionContext,
    branchId: string,
  ): Promise<void> {
    const membership = await client.query<ActorMembership>(
      `SELECT id, role FROM memberships
       WHERE organization_id = $1 AND user_id = $2
         AND status = 'ACTIVE' AND revoked_at IS NULL
       FOR UPDATE`,
      [context.organizationId, context.userId],
    );
    const actor = membership.rows.at(0);
    if (!actor || !['OWNER', 'ADMIN'].includes(actor.role)) {
      throw new CashRegisterManagementError(
        'CASH_REGISTER_MANAGEMENT_FORBIDDEN',
        'Solo OWNER o ADMIN pueden administrar cajas.',
      );
    }
    const branch = await client.query<{ id: string }>(
      `SELECT id FROM branches
       WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, branchId],
    );
    if (!branch.rows.at(0)) {
      throw new CashRegisterManagementError(
        'CASH_REGISTER_BRANCH_NOT_AVAILABLE',
        'La sucursal no está disponible en la organización.',
      );
    }
    if (actor.role === 'ADMIN') {
      const scope = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM effective_membership_branch_scope
           WHERE organization_id = $1 AND membership_id = $2 AND branch_id = $3
         ) AS exists`,
        [context.organizationId, actor.id, branchId],
      );
      if (scope.rows.at(0)?.exists !== true) {
        throw new CashRegisterManagementError(
          'CASH_REGISTER_BRANCH_FORBIDDEN',
          'ADMIN solo puede administrar cajas dentro de sus sucursales asignadas.',
        );
      }
    }
  }
}

function normalizeName(rawName: string): string {
  const name = rawName.trim();
  if (name.length === 0) {
    throw new CashRegisterManagementError(
      'CASH_REGISTER_NAME_INVALID',
      'El nombre de la caja es obligatorio.',
    );
  }
  return name;
}
