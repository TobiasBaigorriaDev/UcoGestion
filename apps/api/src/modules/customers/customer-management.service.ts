import { randomUUID } from 'node:crypto';

import type { DatabaseError, PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface CustomerCreateInput {
  readonly name: string;
  readonly taxId?: string | null | undefined;
  readonly contact?: string | null | undefined;
  readonly address?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

export interface CustomerUpdateInput {
  readonly name?: string | undefined;
  readonly taxId?: string | null | undefined;
  readonly contact?: string | null | undefined;
  readonly address?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

export interface CustomerListQuery {
  readonly status?: 'ACTIVE' | 'INACTIVE' | undefined;
  readonly search?: string | undefined;
  readonly limit?: number | undefined;
}

export interface CustomerResult {
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

export type CustomerManagementErrorCode =
  | 'CUSTOMER_ACCESS_FORBIDDEN'
  | 'CUSTOMER_DELETE_BLOCKED_BY_HISTORY'
  | 'CUSTOMER_NAME_INVALID'
  | 'CUSTOMER_NOT_FOUND'
  | 'CUSTOMER_STATUS_CHANGE_FORBIDDEN'
  | 'CUSTOMER_TAX_ID_DUPLICATE'
  | 'VERSION_CONFLICT';

export class CustomerManagementError extends Error {
  constructor(
    readonly code: CustomerManagementErrorCode,
    message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = 'CustomerManagementError';
  }
}

export class CustomerManagementService {
  constructor(private readonly transactions: TenantTransaction) {}

  async create(
    context: TenantTransactionContext,
    input: CustomerCreateInput,
  ): Promise<CustomerResult> {
    const name = input.name?.trim();
    if (!name || name.length === 0) {
      throw new CustomerManagementError(
        'CUSTOMER_NAME_INVALID',
        'El nombre del cliente es obligatorio.',
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
          action: 'customer.created',
          after: { address, contact, name, notes, status: 'ACTIVE', taxId },
          afterAllowlist: ['address', 'contact', 'name', 'notes', 'status', 'taxId'],
          before: {},
          beforeAllowlist: [],
          branchId: null,
          context: {},
          contextAllowlist: [],
          entityId: id,
          entityType: 'customer',
          operationId: id,
        },
        async (client) => {
          await this.requireCanCreateOrEdit(client, context);

          if (taxId !== null) {
            const existing = await client.query<{ id: string }>(
              `SELECT id FROM customers
               WHERE organization_id = $1 AND tax_id_norm = upper(btrim($2))`,
              [context.organizationId, taxId],
            );
            if ((existing.rowCount ?? 0) > 0) {
              throw new CustomerManagementError(
                'CUSTOMER_TAX_ID_DUPLICATE',
                'Ya existe un cliente con ese identificador fiscal en la organización.',
              );
            }
          }

          const result = await client.query<CustomerResult>(
            `INSERT INTO customers (id, organization_id, name, tax_id, contact, address, notes, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')
             RETURNING id, name, tax_id AS "taxId", contact, address, notes, status,
               version::integer AS version,
               created_at::text AS "createdAt",
               updated_at::text AS "updatedAt"`,
            [id, context.organizationId, name, taxId, contact, address, notes],
          );
          const row = result.rows.at(0);
          if (!row) throw new Error('El cliente no fue persistido.');
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
  ): Promise<CustomerResult> {
    return await this.transactions.read(context, async (client) => {
      await this.requireCanRead(client, context);

      const result = await client.query<CustomerResult>(
        `SELECT id, name, tax_id AS "taxId", contact, address, notes, status,
           version::integer AS version,
           created_at::text AS "createdAt",
           updated_at::text AS "updatedAt"
         FROM customers
         WHERE organization_id = $1 AND id = $2`,
        [context.organizationId, id],
      );
      const row = result.rows.at(0);
      if (!row) {
        throw new CustomerManagementError('CUSTOMER_NOT_FOUND', 'Cliente no encontrado.');
      }
      return row;
    });
  }

  async list(
    context: TenantTransactionContext,
    query?: CustomerListQuery,
  ): Promise<{ items: CustomerResult[] }> {
    return await this.transactions.read(context, async (client) => {
      await this.requireCanRead(client, context);

      const params: unknown[] = [context.organizationId];
      let sql = `SELECT id, name, tax_id AS "taxId", contact, address, notes, status,
                   version::integer AS version,
                   created_at::text AS "createdAt",
                   updated_at::text AS "updatedAt"
                 FROM customers
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

      const result = await client.query<CustomerResult>(sql, params);
      return { items: result.rows };
    });
  }

  async update(
    context: TenantTransactionContext,
    id: string,
    expectedVersion: number,
    input: CustomerUpdateInput,
  ): Promise<CustomerResult> {
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length === 0)) {
      throw new CustomerManagementError('CUSTOMER_NAME_INVALID', 'El nombre del cliente es obligatorio.');
    }

    try {
      return await this.transactions.run(
        context,
        {
          action: 'customer.updated',
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
          context: { customerId: id, expectedVersion },
          contextAllowlist: ['customerId', 'expectedVersion'],
          entityId: id,
          entityType: 'customer',
          operationId: randomUUID(),
        },
        async (client) => {
          await this.requireCanCreateOrEdit(client, context);

          const existing = await client.query<CustomerResult>(
            `SELECT id, name, tax_id AS "taxId", contact, address, notes, status,
               version::integer AS version
             FROM customers
             WHERE organization_id = $1 AND id = $2
             FOR UPDATE`,
            [context.organizationId, id],
          );
          const current = existing.rows.at(0);
          if (!current) {
            throw new CustomerManagementError('CUSTOMER_NOT_FOUND', 'Cliente no encontrado.');
          }

          if (current.version !== expectedVersion) {
            throw new CustomerManagementError(
              'VERSION_CONFLICT',
              'El cliente fue modificado por otra operación.',
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
              `SELECT id FROM customers
               WHERE organization_id = $1 AND tax_id_norm = upper(btrim($2)) AND id <> $3`,
              [context.organizationId, newTaxId, id],
            );
            if ((taxConflict.rowCount ?? 0) > 0) {
              throw new CustomerManagementError(
                'CUSTOMER_TAX_ID_DUPLICATE',
                'Ya existe un cliente con ese identificador fiscal en la organización.',
              );
            }
          }

          const updated = await client.query<CustomerResult>(
            `UPDATE customers
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
          if (!row) throw new Error('El cliente no pudo ser actualizado.');
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
  ): Promise<CustomerResult> {
    try {
      return await this.transactions.run(
        context,
        {
          action: 'customer.status_changed',
          after: { status: targetStatus },
          afterAllowlist: ['status'],
          before: {},
          beforeAllowlist: [],
          branchId: null,
          context: { customerId: id, expectedVersion },
          contextAllowlist: ['customerId', 'expectedVersion'],
          entityId: id,
          entityType: 'customer',
          operationId: randomUUID(),
        },
        async (client) => {
          await this.requireOwnerOrAdmin(client, context, 'CUSTOMER_STATUS_CHANGE_FORBIDDEN');

          const existing = await client.query<CustomerResult>(
            `SELECT id, name, tax_id AS "taxId", contact, address, notes, status,
               version::integer AS version
             FROM customers
             WHERE organization_id = $1 AND id = $2
             FOR UPDATE`,
            [context.organizationId, id],
          );
          const current = existing.rows.at(0);
          if (!current) {
            throw new CustomerManagementError('CUSTOMER_NOT_FOUND', 'Cliente no encontrado.');
          }

          if (current.version !== expectedVersion) {
            throw new CustomerManagementError(
              'VERSION_CONFLICT',
              'El cliente fue modificado por otra operación.',
              current.version,
            );
          }

          const updated = await client.query<CustomerResult>(
            `UPDATE customers
             SET status = $1, version = version + 1, updated_at = now()
             WHERE organization_id = $2 AND id = $3
             RETURNING id, name, tax_id AS "taxId", contact, address, notes, status,
               version::integer AS version,
               created_at::text AS "createdAt",
               updated_at::text AS "updatedAt"`,
            [targetStatus, context.organizationId, id],
          );

          const row = updated.rows.at(0);
          if (!row) throw new Error('El estado del cliente no pudo ser actualizado.');
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
          action: 'customer.deleted',
          after: {},
          afterAllowlist: [],
          before: {},
          beforeAllowlist: [],
          branchId: null,
          context: { customerId: id, expectedVersion },
          contextAllowlist: ['customerId', 'expectedVersion'],
          entityId: id,
          entityType: 'customer',
          operationId: randomUUID(),
        },
        async (client) => {
          await this.requireOwnerOrAdmin(client, context, 'CUSTOMER_ACCESS_FORBIDDEN');

          const existing = await client.query<{ id: string; version: number }>(
            `SELECT id, version::integer AS version
             FROM customers
             WHERE organization_id = $1 AND id = $2
             FOR UPDATE`,
            [context.organizationId, id],
          );
          const current = existing.rows.at(0);
          if (!current) {
            throw new CustomerManagementError('CUSTOMER_NOT_FOUND', 'Cliente no encontrado.');
          }

          if (current.version !== expectedVersion) {
            throw new CustomerManagementError(
              'VERSION_CONFLICT',
              'El cliente fue modificado por otra operación.',
              current.version,
            );
          }

          const history = await client.query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM customer_history_references
               WHERE organization_id = $1 AND customer_id = $2
             ) AS exists`,
            [context.organizationId, id],
          );
          if (history.rows.at(0)?.exists === true) {
            throw new CustomerManagementError(
              'CUSTOMER_DELETE_BLOCKED_BY_HISTORY',
              'El cliente posee historial y no puede ser eliminado físicamente.',
            );
          }

          await client.query(
            `DELETE FROM customers WHERE organization_id = $1 AND id = $2`,
            [context.organizationId, id],
          );

          return { id, deleted: true as const };
        },
      );
    } catch (error) {
      if ((error as Partial<DatabaseError>).code === '23503') {
        throw new CustomerManagementError(
          'CUSTOMER_DELETE_BLOCKED_BY_HISTORY',
          'El cliente posee referencias históricas y no puede ser eliminado.',
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
    if (!role || (role !== 'OWNER' && role !== 'ADMIN' && role !== 'CASHIER')) {
      throw new CustomerManagementError(
        'CUSTOMER_ACCESS_FORBIDDEN',
        'No tenés permisos para consultar clientes.',
      );
    }
    return { role };
  }

  private async requireCanCreateOrEdit(
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
    if (!role || (role !== 'OWNER' && role !== 'ADMIN' && role !== 'CASHIER')) {
      throw new CustomerManagementError(
        'CUSTOMER_ACCESS_FORBIDDEN',
        'No tenés permisos para gestionar clientes.',
      );
    }
    return { role };
  }

  private async requireOwnerOrAdmin(
    client: PoolClient,
    context: TenantTransactionContext,
    errorCode: CustomerManagementErrorCode = 'CUSTOMER_ACCESS_FORBIDDEN',
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
      throw new CustomerManagementError(
        errorCode,
        'Solo OWNER o ADMIN pueden realizar esta acción.',
      );
    }
  }

  private handleDatabaseError(error: unknown): never {
    if (error instanceof CustomerManagementError) {
      throw error;
    }
    if ((error as Partial<DatabaseError>).code === '23505') {
      const constraint = (error as Partial<DatabaseError>).constraint;
      if (constraint === 'customers_organization_tax_id_norm_key') {
        throw new CustomerManagementError(
          'CUSTOMER_TAX_ID_DUPLICATE',
          'Ya existe un cliente con ese identificador fiscal en la organización.',
        );
      }
    }
    throw error;
  }
}
