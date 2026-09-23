import { randomUUID } from 'node:crypto';

import type { DatabaseError, PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface SupplierCreateInput {
  readonly name: string;
  readonly taxId?: string | null | undefined;
  readonly contact?: string | null | undefined;
  readonly address?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

export interface SupplierUpdateInput {
  readonly name?: string | undefined;
  readonly taxId?: string | null | undefined;
  readonly contact?: string | null | undefined;
  readonly address?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

export interface SupplierListQuery {
  readonly status?: 'ACTIVE' | 'INACTIVE' | undefined;
  readonly search?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SupplierResult {
  readonly id: string;
  readonly name: string;
  readonly taxId: string | null;
  readonly contact: string | null;
  readonly address: string | null;
  readonly notes: string | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SupplierManagementErrorCode =
  | 'SUPPLIER_ACCESS_FORBIDDEN'
  | 'SUPPLIER_DELETE_BLOCKED_BY_HISTORY'
  | 'SUPPLIER_NAME_INVALID'
  | 'SUPPLIER_NOT_FOUND'
  | 'SUPPLIER_STATUS_CHANGE_FORBIDDEN'
  | 'SUPPLIER_TAX_ID_DUPLICATE'
  | 'VERSION_CONFLICT';

export class SupplierManagementError extends Error {
  constructor(
    readonly code: SupplierManagementErrorCode,
    message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = 'SupplierManagementError';
  }
}

export class SupplierManagementService {
  constructor(private readonly transactions: TenantTransaction) {}

  async create(
    context: TenantTransactionContext,
    input: SupplierCreateInput,
  ): Promise<SupplierResult> {
    const name = input.name?.trim();
    if (!name || name.length === 0) {
      throw new SupplierManagementError(
        'SUPPLIER_NAME_INVALID',
        'El nombre del proveedor es obligatorio.',
      );
    }

    const taxId = input.taxId !== undefined && input.taxId !== null
      ? (input.taxId.trim().length > 0 ? input.taxId.trim() : null)
      : null;
    const contact = input.contact?.trim() || null;
    const address = input.address?.trim() || null;
    const notes = input.notes?.trim() || null;

    const id = randomUUID();

    try {
      return await this.transactions.run(
        context,
        {
          action: 'supplier.created',
          after: { address, contact, name, notes, status: 'ACTIVE', taxId },
          afterAllowlist: ['address', 'contact', 'name', 'notes', 'status', 'taxId'],
          before: {},
          beforeAllowlist: [],
          branchId: null,
          context: {},
          contextAllowlist: [],
          entityId: id,
          entityType: 'supplier',
          operationId: id,
        },
        async (client) => {
          await this.requireOwnerOrAdmin(client, context);

          if (taxId !== null) {
            const existing = await client.query<{ id: string }>(
              `SELECT id FROM suppliers
               WHERE organization_id = $1 AND tax_id_norm = upper(btrim($2))`,
              [context.organizationId, taxId],
            );
            if ((existing.rowCount ?? 0) > 0) {
              throw new SupplierManagementError(
                'SUPPLIER_TAX_ID_DUPLICATE',
                'Ya existe un proveedor con ese identificador fiscal en la organización.',
              );
            }
          }

          const result = await client.query<SupplierResult>(
            `INSERT INTO suppliers (id, organization_id, name, tax_id, contact, address, notes, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')
             RETURNING id, name, tax_id AS "taxId", contact, address, notes, status,
               version::integer AS version,
               created_at::text AS "createdAt",
               updated_at::text AS "updatedAt"`,
            [id, context.organizationId, name, taxId, contact, address, notes],
          );
          const row = result.rows.at(0);
          if (!row) throw new Error('El proveedor no fue persistido.');
          return row;
        },
      );
    } catch (error) {
      this.handleDatabaseError(error);
    }
  }

  async findById(
    context: TenantTransactionContext,
    id: string,
  ): Promise<SupplierResult> {
    return await this.transactions.read(context, async (client) => {
      await this.requireCanRead(client, context);

      const result = await client.query<SupplierResult>(
        `SELECT id, name, tax_id AS "taxId", contact, address, notes, status,
           version::integer AS version,
           created_at::text AS "createdAt",
           updated_at::text AS "updatedAt"
         FROM suppliers
         WHERE organization_id = $1 AND id = $2`,
        [context.organizationId, id],
      );
      const row = result.rows.at(0);
      if (!row) {
        throw new SupplierManagementError('SUPPLIER_NOT_FOUND', 'Proveedor no encontrado.');
      }
      return row;
    });
  }

  async list(
    context: TenantTransactionContext,
    query?: SupplierListQuery,
  ): Promise<{ items: SupplierResult[] }> {
    return await this.transactions.read(context, async (client) => {
      await this.requireCanRead(client, context);

      const params: unknown[] = [context.organizationId];
      let sql = `SELECT id, name, tax_id AS "taxId", contact, address, notes, status,
                   version::integer AS version,
                   created_at::text AS "createdAt",
                   updated_at::text AS "updatedAt"
                 FROM suppliers
                 WHERE organization_id = $1`;

      if (query?.status) {
        params.push(query.status);
        sql += ` AND status = $${params.length}`;
      }

      if (query?.search?.trim()) {
        params.push(`%${query.search.trim()}%`);
        sql += ` AND (name ILIKE $${params.length} OR tax_id_norm ILIKE $${params.length})`;
      }

      sql += ` ORDER BY created_at DESC`;

      if (query?.limit && query.limit > 0) {
        params.push(query.limit);
        sql += ` LIMIT $${params.length}`;
      }

      const result = await client.query<SupplierResult>(sql, params);
      return { items: result.rows };
    });
  }

  async update(
    context: TenantTransactionContext,
    id: string,
    expectedVersion: number,
    input: SupplierUpdateInput,
  ): Promise<SupplierResult> {
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length === 0)) {
      throw new SupplierManagementError('SUPPLIER_NAME_INVALID', 'El nombre del proveedor es obligatorio.');
    }

    try {
      return await this.transactions.run(
        context,
        {
          action: 'supplier.updated',
          after: {
            address: input.address ?? null,
            contact: input.contact ?? null,
            name: input.name ?? null,
            notes: input.notes ?? null,
            taxId: input.taxId ?? null,
          },
          afterAllowlist: ['address', 'contact', 'name', 'notes', 'taxId'],
          before: {},
          beforeAllowlist: [],
          branchId: null,
          context: { supplierId: id, expectedVersion },
          contextAllowlist: ['supplierId', 'expectedVersion'],
          entityId: id,
          entityType: 'supplier',
          operationId: randomUUID(),
        },
        async (client) => {
          await this.requireOwnerOrAdmin(client, context);

          const existing = await client.query<SupplierResult>(
            `SELECT id, name, tax_id AS "taxId", contact, address, notes, status,
               version::integer AS version
             FROM suppliers
             WHERE organization_id = $1 AND id = $2
             FOR UPDATE`,
            [context.organizationId, id],
          );
          const current = existing.rows.at(0);
          if (!current) {
            throw new SupplierManagementError('SUPPLIER_NOT_FOUND', 'Proveedor no encontrado.');
          }

          if (current.version !== expectedVersion) {
            throw new SupplierManagementError(
              'VERSION_CONFLICT',
              'El proveedor fue modificado por otra operación.',
              current.version,
            );
          }

          const newName = input.name !== undefined ? input.name.trim() : current.name;
          const newTaxId = input.taxId !== undefined
            ? (input.taxId && input.taxId.trim().length > 0 ? input.taxId.trim() : null)
            : current.taxId;
          const newContact = input.contact !== undefined ? (input.contact?.trim() || null) : current.contact;
          const newAddress = input.address !== undefined ? (input.address?.trim() || null) : current.address;
          const newNotes = input.notes !== undefined ? (input.notes?.trim() || null) : current.notes;

          if (newTaxId !== null) {
            const taxConflict = await client.query<{ id: string }>(
              `SELECT id FROM suppliers
               WHERE organization_id = $1 AND tax_id_norm = upper(btrim($2)) AND id <> $3`,
              [context.organizationId, newTaxId, id],
            );
            if ((taxConflict.rowCount ?? 0) > 0) {
              throw new SupplierManagementError(
                'SUPPLIER_TAX_ID_DUPLICATE',
                'Ya existe un proveedor con ese identificador fiscal en la organización.',
              );
            }
          }

          const updated = await client.query<SupplierResult>(
            `UPDATE suppliers
             SET name = $1, tax_id = $2, contact = $3, address = $4, notes = $5,
                 version = version + 1, updated_at = now()
             WHERE organization_id = $6 AND id = $7
             RETURNING id, name, tax_id AS "taxId", contact, address, notes, status,
               version::integer AS version,
               created_at::text AS "createdAt",
               updated_at::text AS "updatedAt"`,
            [newName, newTaxId, newContact, newAddress, newNotes, context.organizationId, id],
          );

          const row = updated.rows.at(0);
          if (!row) throw new Error('El proveedor no pudo ser actualizado.');
          return row;
        },
      );
    } catch (error) {
      this.handleDatabaseError(error);
    }
  }

  async changeStatus(
    context: TenantTransactionContext,
    id: string,
    expectedVersion: number,
    targetStatus: 'ACTIVE' | 'INACTIVE',
  ): Promise<SupplierResult> {
    try {
      return await this.transactions.run(
        context,
        {
          action: 'supplier.status_changed',
          after: { status: targetStatus },
          afterAllowlist: ['status'],
          before: {},
          beforeAllowlist: [],
          branchId: null,
          context: { supplierId: id, expectedVersion },
          contextAllowlist: ['supplierId', 'expectedVersion'],
          entityId: id,
          entityType: 'supplier',
          operationId: randomUUID(),
        },
        async (client) => {
          await this.requireOwnerOrAdmin(client, context, 'SUPPLIER_STATUS_CHANGE_FORBIDDEN');

          const existing = await client.query<SupplierResult>(
            `SELECT id, name, tax_id AS "taxId", contact, address, notes, status,
               version::integer AS version
             FROM suppliers
             WHERE organization_id = $1 AND id = $2
             FOR UPDATE`,
            [context.organizationId, id],
          );
          const current = existing.rows.at(0);
          if (!current) {
            throw new SupplierManagementError('SUPPLIER_NOT_FOUND', 'Proveedor no encontrado.');
          }

          if (current.version !== expectedVersion) {
            throw new SupplierManagementError(
              'VERSION_CONFLICT',
              'El proveedor fue modificado por otra operación.',
              current.version,
            );
          }

          const updated = await client.query<SupplierResult>(
            `UPDATE suppliers
             SET status = $1, version = version + 1, updated_at = now()
             WHERE organization_id = $2 AND id = $3
             RETURNING id, name, tax_id AS "taxId", contact, address, notes, status,
               version::integer AS version,
               created_at::text AS "createdAt",
               updated_at::text AS "updatedAt"`,
            [targetStatus, context.organizationId, id],
          );

          const row = updated.rows.at(0);
          if (!row) throw new Error('El estado del proveedor no pudo ser actualizado.');
          return row;
        },
      );
    } catch (error) {
      this.handleDatabaseError(error);
    }
  }

  async deletePhysically(
    context: TenantTransactionContext,
    id: string,
    expectedVersion: number,
  ): Promise<{ readonly id: string; readonly deleted: true }> {
    try {
      return await this.transactions.run(
        context,
        {
          action: 'supplier.deleted',
          after: {},
          afterAllowlist: [],
          before: {},
          beforeAllowlist: [],
          branchId: null,
          context: { supplierId: id, expectedVersion },
          contextAllowlist: ['supplierId', 'expectedVersion'],
          entityId: id,
          entityType: 'supplier',
          operationId: randomUUID(),
        },
        async (client) => {
          await this.requireOwnerOrAdmin(client, context, 'SUPPLIER_ACCESS_FORBIDDEN');

          const existing = await client.query<{ id: string; version: number }>(
            `SELECT id, version::integer AS version
             FROM suppliers
             WHERE organization_id = $1 AND id = $2
             FOR UPDATE`,
            [context.organizationId, id],
          );
          const current = existing.rows.at(0);
          if (!current) {
            throw new SupplierManagementError('SUPPLIER_NOT_FOUND', 'Proveedor no encontrado.');
          }

          if (current.version !== expectedVersion) {
            throw new SupplierManagementError(
              'VERSION_CONFLICT',
              'El proveedor fue modificado por otra operación.',
              current.version,
            );
          }

          const history = await client.query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM supplier_history_references
               WHERE organization_id = $1 AND supplier_id = $2
             ) AS exists`,
            [context.organizationId, id],
          );
          if (history.rows.at(0)?.exists === true) {
            throw new SupplierManagementError(
              'SUPPLIER_DELETE_BLOCKED_BY_HISTORY',
              'El proveedor posee historial y no puede ser eliminado físicamente.',
            );
          }

          await client.query(
            `DELETE FROM suppliers WHERE organization_id = $1 AND id = $2`,
            [context.organizationId, id],
          );

          return { id, deleted: true as const };
        },
      );
    } catch (error) {
      if ((error as Partial<DatabaseError>).code === '23503') {
        throw new SupplierManagementError(
          'SUPPLIER_DELETE_BLOCKED_BY_HISTORY',
          'El proveedor posee referencias históricas y no puede ser eliminado.',
        );
      }
      this.handleDatabaseError(error);
    }
  }

  private async requireCanRead(
    client: PoolClient,
    context: TenantTransactionContext,
  ): Promise<{ role: string }> {
    const membership = await client.query<{ role: string }>(
      `SELECT role FROM memberships
       WHERE organization_id = $1
         AND user_id = $2
         AND status = 'ACTIVE'
         AND revoked_at IS NULL`,
      [context.organizationId, context.userId],
    );
    const role = membership.rows.at(0)?.role;
    if (!role || (role !== 'OWNER' && role !== 'ADMIN' && role !== 'EMPLOYEE')) {
      throw new SupplierManagementError(
        'SUPPLIER_ACCESS_FORBIDDEN',
        'No tenés permisos para consultar proveedores.',
      );
    }
    return { role };
  }

  private async requireOwnerOrAdmin(
    client: PoolClient,
    context: TenantTransactionContext,
    errorCode: SupplierManagementErrorCode = 'SUPPLIER_ACCESS_FORBIDDEN',
  ): Promise<void> {
    const membership = await client.query<{ role: string }>(
      `SELECT role FROM memberships
       WHERE organization_id = $1
         AND user_id = $2
         AND status = 'ACTIVE'
         AND revoked_at IS NULL`,
      [context.organizationId, context.userId],
    );
    const role = membership.rows.at(0)?.role;
    if (!role || (role !== 'OWNER' && role !== 'ADMIN')) {
      throw new SupplierManagementError(
        errorCode,
        'Solo OWNER o ADMIN pueden realizar esta acción.',
      );
    }
  }

  private handleDatabaseError(error: unknown): never {
    if (error instanceof SupplierManagementError) {
      throw error;
    }
    if ((error as Partial<DatabaseError>).code === '23505') {
      const constraint = (error as Partial<DatabaseError>).constraint;
      if (constraint === 'suppliers_organization_tax_id_norm_key') {
        throw new SupplierManagementError(
          'SUPPLIER_TAX_ID_DUPLICATE',
          'Ya existe un proveedor con ese identificador fiscal en la organización.',
        );
      }
    }
    throw error;
  }
}
