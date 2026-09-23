import { ForbiddenException } from '@nestjs/common';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface OrganizationSettingsView {
  readonly profile: Record<string, string | null>;
  readonly timezone: string;
  readonly version: number;
  readonly role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
}

export class OrganizationSettingsService {
  constructor(private readonly transactions: TenantTransaction) {}

  async read(context: TenantTransactionContext): Promise<OrganizationSettingsView> {
    return this.transactions.read(context, async (client) => {
      const result = await client.query<OrganizationSettingsView>(
        `SELECT o.profile, o.timezone, o.version::integer AS version, m.role
         FROM organizations o
         JOIN memberships m ON m.organization_id = o.id
           AND m.user_id = $2 AND m.status = 'ACTIVE' AND m.revoked_at IS NULL
         WHERE o.id = $1`,
        [context.organizationId, context.userId],
      );
      const row = result.rows[0];
      if (!row) throw new ForbiddenException({
        code: 'ORGANIZATION_NOT_AVAILABLE', title: 'Organización no disponible',
        detail: 'No tenés acceso a esta organización.',
      });
      return row;
    });
  }
}
