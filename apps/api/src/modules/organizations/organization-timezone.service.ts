import { z } from 'zod';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

const ianaTimezoneSchema = z.string().trim().min(1).max(100).refine((timezone) => {
  try {
    new Intl.DateTimeFormat('es-AR', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}, 'La zona horaria debe ser un identificador IANA válido.');

export const organizationTimezoneUpdateSchema = z.strictObject({
  timezone: ianaTimezoneSchema,
});

export type OrganizationTimezoneUpdate = z.infer<typeof organizationTimezoneUpdateSchema>;

export interface OrganizationTimezoneRow {
  readonly timezone: string;
  readonly version: number;
}

export class OrganizationTimezonePermissionError extends Error {
  readonly code = 'ORGANIZATION_TIMEZONE_FORBIDDEN';
}

export class OrganizationTimezoneVersionError extends Error {
  readonly code = 'VERSION_CONFLICT';

  constructor(readonly currentVersion: number) {
    super('La organización fue modificada por otra operación.');
    this.name = 'OrganizationTimezoneVersionError';
  }
}

export class OrganizationTimezoneService {
  constructor(private readonly transactions: TenantTransaction) {}

  async update(
    context: TenantTransactionContext,
    expectedVersion: number,
    rawUpdate: OrganizationTimezoneUpdate,
  ): Promise<OrganizationTimezoneRow> {
    const update = organizationTimezoneUpdateSchema.parse(rawUpdate);
    return this.transactions.run(
      context,
      {
        action: 'organization.timezone_updated',
        after: { timezone: update.timezone },
        afterAllowlist: ['timezone'],
        before: {},
        beforeAllowlist: [],
        branchId: null,
        context: { version: expectedVersion + 1 },
        contextAllowlist: ['version'],
        entityId: context.organizationId,
        entityType: 'organization',
        operationId: context.requestId,
      },
      async (client) => {
        const membership = await client.query<{ role: string }>(
          `SELECT role FROM memberships
           WHERE organization_id = $1 AND user_id = $2 AND revoked_at IS NULL
           FOR UPDATE`,
          [context.organizationId, context.userId],
        );
        if (membership.rows[0]?.role !== 'OWNER') {
          throw new OrganizationTimezonePermissionError('Solo OWNER puede modificar la zona horaria.');
        }

        const updated = await client.query<OrganizationTimezoneRow>(
          `UPDATE organizations
           SET timezone = $1, version = version + 1
           WHERE id = $2 AND version = $3
           RETURNING timezone, version::integer AS version`,
          [update.timezone, context.organizationId, expectedVersion],
        );
        const row = updated.rows[0];
        if (row) return row;

        const current = await client.query<{ version: number }>(
          'SELECT version::integer AS version FROM organizations WHERE id = $1',
          [context.organizationId],
        );
        throw new OrganizationTimezoneVersionError(current.rows[0]?.version ?? expectedVersion);
      },
    );
  }
}
