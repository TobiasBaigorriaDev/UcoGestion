import { z } from 'zod';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export const organizationProfileUpdateSchema = z.strictObject({
  address: z.string().trim().min(1).max(300).nullable().optional(),
  displayName: z.string().trim().min(1).max(200).nullable().optional(),
  email: z.string().trim().pipe(z.email()).nullable().optional(),
  phone: z.string().trim().min(1).max(80).nullable().optional(),
}).refine((profile) => Object.keys(profile).length > 0, 'Debe informar al menos un campo comercial.');

export type OrganizationProfileUpdate = z.infer<typeof organizationProfileUpdateSchema>;

export interface OrganizationProfileRow {
  profile: Record<string, string | null>;
  version: number;
}

export class OrganizationProfilePermissionError extends Error {
  readonly code = 'ORGANIZATION_PROFILE_FORBIDDEN';
}

export class OrganizationProfileVersionError extends Error {
  readonly code = 'VERSION_CONFLICT';

  constructor(readonly currentVersion: number) {
    super('El perfil fue modificado por otra operación.');
    this.name = 'OrganizationProfileVersionError';
  }
}

export class OrganizationProfileService {
  constructor(private readonly transactions: TenantTransaction) {}

  async update(
    context: TenantTransactionContext,
    expectedVersion: number,
    rawProfile: OrganizationProfileUpdate,
  ): Promise<OrganizationProfileRow> {
    const profile = organizationProfileUpdateSchema.parse(rawProfile);
    const auditProfile: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(profile)) {
      if (value !== undefined) auditProfile[key] = value;
    }
    return this.transactions.run(
      context,
      {
        action: 'organization.profile_updated',
        after: auditProfile,
        afterAllowlist: ['address', 'displayName', 'email', 'phone'],
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
           WHERE organization_id = $1
             AND user_id = $2
             AND status = 'ACTIVE'
             AND revoked_at IS NULL
           FOR UPDATE`,
          [context.organizationId, context.userId],
        );
        if (!['OWNER', 'ADMIN'].includes(membership.rows[0]?.role ?? '')) {
          throw new OrganizationProfilePermissionError('Solo OWNER o ADMIN pueden modificar el perfil comercial.');
        }

        const updated = await client.query<OrganizationProfileRow>(
          `UPDATE organizations
           SET profile = profile || $1::jsonb, version = version + 1
           WHERE id = $2 AND version = $3
           RETURNING profile, version::integer AS version`,
          [JSON.stringify(profile), context.organizationId, expectedVersion],
        );
        const row = updated.rows[0];
        if (row) return row;

        const current = await client.query<{ version: number }>(
          'SELECT version::integer AS version FROM organizations WHERE id = $1',
          [context.organizationId],
        );
        throw new OrganizationProfileVersionError(current.rows[0]?.version ?? expectedVersion);
      },
    );
  }
}
