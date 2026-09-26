import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export class DeviceAuthorizationError extends Error {
  constructor(readonly code: 'DEVICE_AUTHORIZATION_FORBIDDEN' | 'DEVICE_BRANCH_NOT_AVAILABLE' | 'DEVICE_BRANCH_FORBIDDEN', message: string) {
    super(message);
    this.name = 'DeviceAuthorizationError';
  }
}

export interface AuthorizedOnlineDevice {
  readonly id: string;
  readonly organizationId: string;
  readonly branchId: string;
  readonly authorizedByUserId: string;
  readonly status: 'ACTIVE';
}

export class DeviceAuthorizationService {
  constructor(private readonly transactions: TenantTransaction) {}

  async authorizeOnline(context: TenantTransactionContext, branchId: string): Promise<AuthorizedOnlineDevice> {
    const id = randomUUID();
    return this.transactions.run(context, {
      action: 'AUTHORIZE_ONLINE', entityType: 'device', entityId: id, operationId: id,
      branchId, deviceId: id, before: {}, beforeAllowlist: [],
      after: { status: 'ACTIVE' }, afterAllowlist: ['status'], context: {}, contextAllowlist: [],
    }, async (client) => {
      await this.requireAuthorizer(client, context, branchId);
      await client.query(
        `INSERT INTO devices (id, organization_id, branch_id, authorized_by_user_id, authorized_at, status)
         VALUES ($1, $2, $3, $4, now(), 'ACTIVE')`,
        [id, context.organizationId, branchId, context.userId],
      );
      return { id, organizationId: context.organizationId, branchId, authorizedByUserId: context.userId, status: 'ACTIVE' };
    });
  }

  private async requireAuthorizer(client: PoolClient, context: TenantTransactionContext, branchId: string): Promise<void> {
    const membership = await client.query<{ id: string; role: string }>(
      `SELECT id, role FROM memberships WHERE organization_id = $1 AND user_id = $2
       AND status = 'ACTIVE' AND revoked_at IS NULL FOR UPDATE`,
      [context.organizationId, context.userId],
    );
    const actor = membership.rows.at(0);
    if (!actor || !['OWNER', 'ADMIN'].includes(actor.role)) {
      throw new DeviceAuthorizationError('DEVICE_AUTHORIZATION_FORBIDDEN', 'Solo OWNER o ADMIN pueden autorizar dispositivos.');
    }
    const branch = await client.query<{ id: string }>(
      `SELECT id FROM branches WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'`,
      [context.organizationId, branchId],
    );
    if (!branch.rows.at(0)) {
      throw new DeviceAuthorizationError('DEVICE_BRANCH_NOT_AVAILABLE', 'La sucursal no está disponible.');
    }
    if (actor.role === 'ADMIN') {
      const scope = await client.query<{ allowed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM effective_membership_branch_scope
         WHERE organization_id = $1 AND membership_id = $2 AND branch_id = $3) AS allowed`,
        [context.organizationId, actor.id, branchId],
      );
      if (!scope.rows.at(0)?.allowed) {
        throw new DeviceAuthorizationError('DEVICE_BRANCH_FORBIDDEN', 'La sucursal no está en el alcance del usuario.');
      }
    }
  }
}
