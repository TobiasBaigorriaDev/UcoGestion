import type { PoolClient } from 'pg';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';

export class CashSessionDeviceError extends Error {
  constructor(readonly code: 'CASH_SESSION_NOT_OPEN' | 'CASH_SESSION_DEVICE_CONFLICT' | 'CASH_SESSION_ACTOR_FORBIDDEN', message: string) {
    super(message);
    this.name = 'CashSessionDeviceError';
  }
}

export interface OperationalCashSession {
  readonly id: string;
  readonly branchId: string;
  readonly deviceId: string;
  readonly ownerUserId: string;
}

export interface AuthorizedCashActor extends OperationalCashSession {
  readonly actorUserId: string;
}

export class CashSessionDevicePolicy {
  async requireOperational(client: PoolClient, organizationId: string, cashSessionId: string,
    deviceId: string, allowClosed = false): Promise<OperationalCashSession> {
    const result = await client.query<{ id: string; branchId: string; deviceId: string; ownerUserId: string; status: string; deviceStatus: string }>(
      `SELECT cs.id, cs.branch_id AS "branchId", cs.device_id AS "deviceId",
         cs.owner_user_id AS "ownerUserId", cs.status,
         d.status AS "deviceStatus"
       FROM cash_sessions cs JOIN devices d
         ON d.organization_id = cs.organization_id AND d.id = cs.device_id
       WHERE cs.organization_id = $1 AND cs.id = $2 FOR UPDATE OF cs`,
      [organizationId, cashSessionId],
    );
    const session = result.rows.at(0);
    if (!session || (!allowClosed && session.status !== 'OPEN')) {
      throw new CashSessionDeviceError('CASH_SESSION_NOT_OPEN', 'La sesión no está abierta.');
    }
    if (session.deviceId !== deviceId || session.deviceStatus !== 'ACTIVE') {
      throw new CashSessionDeviceError('CASH_SESSION_DEVICE_CONFLICT', 'La operación debe originarse en el dispositivo de la sesión.');
    }
    return { id: session.id, branchId: session.branchId, deviceId: session.deviceId,
      ownerUserId: session.ownerUserId };
  }

  async requireAuthorizedActor(client: PoolClient, context: TenantTransactionContext,
    cashSessionId: string, deviceId: string, allowClosed = false): Promise<AuthorizedCashActor> {
    const session = await this.requireOperational(client, context.organizationId, cashSessionId, deviceId, allowClosed);
    const membership = await client.query<{ id: string; role: string }>(
      `SELECT id, role FROM memberships WHERE organization_id = $1 AND user_id = $2
       AND status = 'ACTIVE' AND revoked_at IS NULL`, [context.organizationId, context.userId]);
    const actor = membership.rows.at(0);
    if (!actor || !['OWNER', 'ADMIN', 'CASHIER'].includes(actor.role) ||
      (actor.role === 'CASHIER' && session.ownerUserId !== context.userId)) {
      throw new CashSessionDeviceError('CASH_SESSION_ACTOR_FORBIDDEN', 'El usuario no puede operar esta sesión.');
    }
    if (actor.role !== 'OWNER') {
      const scope = await client.query<{ allowed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM effective_membership_branch_scope
         WHERE organization_id = $1 AND membership_id = $2 AND branch_id = $3) AS allowed`,
        [context.organizationId, actor.id, session.branchId]);
      if (!scope.rows.at(0)?.allowed) {
        throw new CashSessionDeviceError('CASH_SESSION_ACTOR_FORBIDDEN', 'La sesión está fuera del alcance del usuario.');
      }
    }
    return { ...session, actorUserId: context.userId };
  }
}
