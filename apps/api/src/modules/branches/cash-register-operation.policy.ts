import type { PoolClient } from 'pg';

export interface OpenableCashRegister {
  readonly branchId: string;
  readonly id: string;
  readonly status: 'ACTIVE';
  readonly version: number;
}

export type CashRegisterOperationErrorCode =
  | 'CASH_REGISTER_INACTIVE'
  | 'CASH_REGISTER_NOT_AVAILABLE';

export class CashRegisterOperationError extends Error {
  constructor(
    readonly code: CashRegisterOperationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CashRegisterOperationError';
  }
}

export class CashRegisterOperationPolicy {
  async requireOpenable(
    client: PoolClient,
    organizationId: string,
    cashRegisterId: string,
  ): Promise<OpenableCashRegister> {
    const result = await client.query<{
      branchId: string;
      id: string;
      status: string;
      version: number;
    }>(
      `SELECT id, branch_id AS "branchId", status, version::integer AS version
       FROM cash_registers
       WHERE organization_id = $1 AND id = $2
       FOR UPDATE`,
      [organizationId, cashRegisterId],
    );
    const row = result.rows.at(0);
    if (!row) {
      throw new CashRegisterOperationError(
        'CASH_REGISTER_NOT_AVAILABLE',
        'La caja no está disponible en la organización.',
      );
    }
    if (row.status !== 'ACTIVE') {
      throw new CashRegisterOperationError(
        'CASH_REGISTER_INACTIVE',
        'La caja está inactiva y no admite nuevas aperturas.',
      );
    }
    return { branchId: row.branchId, id: row.id, status: 'ACTIVE', version: row.version };
  }
}
