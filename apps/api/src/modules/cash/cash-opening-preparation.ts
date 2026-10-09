import { Money, validateNonNegativeMoney } from '@uconext/shared';
import type { PoolClient } from 'pg';

import type { TenantTransactionContext } from '../../database/tenant-transaction.js';

export type CashOpeningErrorCode =
  | 'CASH_OPENING_AMOUNT_INVALID'
  | 'CASH_OPENING_REGISTER_NOT_AVAILABLE'
  | 'CASH_OPENING_BRANCH_MISMATCH'
  | 'CASH_OPENING_DEVICE_NOT_AVAILABLE'
  | 'CASH_OPENING_ALREADY_ACTIVE'
  | 'CASH_OPENING_FORBIDDEN';

export class CashOpeningError extends Error {
  constructor(readonly code: CashOpeningErrorCode, message: string) {
    super(message);
    this.name = 'CashOpeningError';
  }
}

export interface CashOpeningInput {
  readonly branchId: string;
  readonly cashRegisterId: string;
  readonly deviceId: string;
  readonly openingCash: string;
}

export interface PreparedCashOpening extends CashOpeningInput {
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly origin: 'ONLINE';
  readonly status: 'OPEN';
  readonly currencyCode: string;
}

/** Internal preparation only. The HTTP opening command is introduced by T121A. */
export class CashOpeningPreparation {
  async prepare(client: PoolClient, context: TenantTransactionContext, input: CashOpeningInput): Promise<PreparedCashOpening> {
    await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [context.organizationId]);
    const branch = await client.query("SELECT id FROM branches WHERE organization_id=$1 AND id=$2 AND status='ACTIVE' FOR SHARE", [context.organizationId,input.branchId]);
    if (!branch.rowCount) throw new CashOpeningError('CASH_OPENING_REGISTER_NOT_AVAILABLE', 'La sucursal no está disponible.');
    const openingCash = validateNonNegativeMoney(input.openingCash);
    if (openingCash === undefined) {
      throw new CashOpeningError('CASH_OPENING_AMOUNT_INVALID', 'El efectivo inicial debe ser no negativo y tener dos decimales.');
    }
    const register = await client.query<{ branchId: string }>(
      `SELECT cr.branch_id AS "branchId" FROM cash_registers cr
       JOIN branches b ON b.organization_id = cr.organization_id AND b.id = cr.branch_id
       WHERE cr.organization_id = $1 AND cr.id = $2 AND cr.status = 'ACTIVE' AND b.status = 'ACTIVE'
       FOR UPDATE OF cr`,
      [context.organizationId, input.cashRegisterId],
    );
    const row = register.rows.at(0);
    if (!row) throw new CashOpeningError('CASH_OPENING_REGISTER_NOT_AVAILABLE', 'La caja no está disponible.');
    if (row.branchId !== input.branchId) {
      throw new CashOpeningError('CASH_OPENING_BRANCH_MISMATCH', 'La caja no pertenece a la sucursal indicada.');
    }
    const membership = await client.query<{ id: string; role: string }>(
      `SELECT id, role FROM memberships WHERE organization_id = $1 AND user_id = $2
       AND status = 'ACTIVE' AND revoked_at IS NULL FOR UPDATE`,
      [context.organizationId, context.userId],
    );
    const actor = membership.rows.at(0);
    if (!actor || !['OWNER', 'ADMIN', 'CASHIER'].includes(actor.role)) {
      throw new CashOpeningError('CASH_OPENING_FORBIDDEN', 'El usuario no puede abrir sesiones de caja.');
    }
    if (actor.role !== 'OWNER') {
      const scope = await client.query<{ allowed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM effective_membership_branch_scope
         WHERE organization_id = $1 AND membership_id = $2 AND branch_id = $3) AS allowed`,
        [context.organizationId, actor.id, input.branchId],
      );
      if (!scope.rows.at(0)?.allowed) {
        throw new CashOpeningError('CASH_OPENING_FORBIDDEN', 'La caja queda fuera del alcance del usuario.');
      }
    }
    const active = await client.query(
      `SELECT 1 FROM cash_sessions WHERE organization_id = $1 AND cash_register_id = $2
         AND status IN ('OPEN', 'CLOSING', 'CONFLICTED') LIMIT 1`,
      [context.organizationId, input.cashRegisterId],
    );
    if (active.rowCount) {
      throw new CashOpeningError('CASH_OPENING_ALREADY_ACTIVE', 'La caja tiene una sesión activa o en conflicto.');
    }
    const device = await client.query(
      `SELECT 1 FROM devices WHERE organization_id = $1 AND branch_id = $2 AND id = $3 AND status = 'ACTIVE'`,
      [context.organizationId, input.branchId, input.deviceId],
    );
    if (!device.rowCount) {
      throw new CashOpeningError('CASH_OPENING_DEVICE_NOT_AVAILABLE', 'El dispositivo no está autorizado para la sucursal.');
    }
    const organization = await client.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1', [context.organizationId]);
    const currencyCode = organization.rows.at(0)?.base_currency;
    if (!currencyCode) throw new CashOpeningError('CASH_OPENING_REGISTER_NOT_AVAILABLE', 'La organización no está disponible.');
    return { ...input, openingCash: Money.from(openingCash).toString(),
      organizationId: context.organizationId, ownerUserId: context.userId,
      origin: 'ONLINE', status: 'OPEN', currencyCode };
  }
}
