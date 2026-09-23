import { randomUUID } from 'node:crypto';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export class UnrecoverableDeviceError extends Error {
  constructor(readonly code: 'DEVICE_DECLARATION_FORBIDDEN' | 'DEVICE_NOT_FOUND', message: string) {
    super(message);
    this.name = 'UnrecoverableDeviceError';
  }
}

export class UnrecoverableDeviceService {
  constructor(private readonly transactions: TenantTransaction) {}

  async declare(
    context: TenantTransactionContext,
    deviceId: string,
  ): Promise<{ readonly declarationId: string; readonly permanentlyLocked: boolean }> {
    const declarationId = randomUUID();
    return this.transactions.run(context, {
      action: 'device.declared_unrecoverable',
      after: {}, afterAllowlist: [], before: {}, beforeAllowlist: [],
      branchId: null, context: {}, contextAllowlist: [],
      entityId: deviceId, entityType: 'device', operationId: declarationId,
    }, async (client) => {
      const membership = await client.query<{ role: string }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2
         AND status = 'ACTIVE' AND revoked_at IS NULL`,
        [context.organizationId, context.userId],
      );
      if (membership.rows[0]?.role !== 'OWNER') {
        throw new UnrecoverableDeviceError('DEVICE_DECLARATION_FORBIDDEN', 'Solo OWNER puede declarar irrecuperable un dispositivo.');
      }
      await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [context.organizationId]);
      const device = await client.query(
        'SELECT id FROM devices WHERE organization_id = $1 AND id = $2 FOR UPDATE',
        [context.organizationId, deviceId],
      );
      if ((device.rowCount ?? 0) === 0) {
        throw new UnrecoverableDeviceError('DEVICE_NOT_FOUND', 'El dispositivo no pertenece a esta organización.');
      }
      const prior = await client.query<{ id: string; possible_unknown_history: boolean }>(
        `SELECT id, possible_unknown_history FROM unrecoverable_device_declarations
         WHERE organization_id = $1 AND device_id = $2 AND request_id = $3`,
        [context.organizationId, deviceId, context.requestId],
      );
      if (prior.rows[0]) {
        return { declarationId: prior.rows[0].id,
          permanentlyLocked: prior.rows[0].possible_unknown_history };
      }
      const possible = await client.query(
        `SELECT 1 FROM offline_configuration_exposures
         WHERE organization_id = $1 AND device_id = $2 AND cleared_at IS NULL LIMIT 1`,
        [context.organizationId, deviceId],
      );
      const permanentlyLocked = (possible.rowCount ?? 0) > 0;
      await client.query(
        `INSERT INTO unrecoverable_device_declarations
           (id, organization_id, device_id, declared_by, request_id, possible_unknown_history)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [declarationId, context.organizationId, deviceId, context.userId, context.requestId,
          permanentlyLocked],
      );
      await client.query(
        `UPDATE devices SET status = 'UNRECOVERABLE' WHERE organization_id = $1 AND id = $2`,
        [context.organizationId, deviceId],
      );
      return { declarationId, permanentlyLocked };
    });
  }
}
