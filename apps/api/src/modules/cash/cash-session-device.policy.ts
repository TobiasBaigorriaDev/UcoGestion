import type { PoolClient } from 'pg';

export class CashSessionDeviceError extends Error {
  constructor(readonly code: 'CASH_SESSION_NOT_OPEN' | 'CASH_SESSION_DEVICE_CONFLICT', message: string) {
    super(message);
    this.name = 'CashSessionDeviceError';
  }
}

export interface OperationalCashSession {
  readonly id: string;
  readonly branchId: string;
  readonly deviceId: string;
}

export class CashSessionDevicePolicy {
  async requireOperational(client: PoolClient, organizationId: string, cashSessionId: string,
    deviceId: string): Promise<OperationalCashSession> {
    const result = await client.query<{ id: string; branchId: string; deviceId: string; status: string; deviceStatus: string }>(
      `SELECT cs.id, cs.branch_id AS "branchId", cs.device_id AS "deviceId", cs.status,
         d.status AS "deviceStatus"
       FROM cash_sessions cs JOIN devices d
         ON d.organization_id = cs.organization_id AND d.id = cs.device_id
       WHERE cs.organization_id = $1 AND cs.id = $2 FOR UPDATE OF cs`,
      [organizationId, cashSessionId],
    );
    const session = result.rows.at(0);
    if (!session || session.status !== 'OPEN') {
      throw new CashSessionDeviceError('CASH_SESSION_NOT_OPEN', 'La sesión no está abierta.');
    }
    if (session.deviceId !== deviceId || session.deviceStatus !== 'ACTIVE') {
      throw new CashSessionDeviceError('CASH_SESSION_DEVICE_CONFLICT', 'La operación debe originarse en el dispositivo de la sesión.');
    }
    return { id: session.id, branchId: session.branchId, deviceId: session.deviceId };
  }
}
