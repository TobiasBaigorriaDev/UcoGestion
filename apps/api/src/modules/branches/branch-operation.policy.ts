import type { PoolClient } from 'pg';

export interface OperationalBranch {
  readonly id: string;
  readonly status: 'ACTIVE';
  readonly version: number;
}

export type BranchOperationErrorCode = 'BRANCH_INACTIVE' | 'BRANCH_NOT_AVAILABLE';

export class BranchOperationError extends Error {
  constructor(
    readonly code: BranchOperationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BranchOperationError';
  }
}

export class BranchOperationPolicy {
  async requireActive(
    client: PoolClient,
    organizationId: string,
    branchId: string,
  ): Promise<OperationalBranch> {
    const result = await client.query<{ id: string; status: string; version: number }>(
      `SELECT id, status, version::integer AS version
       FROM branches
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, branchId],
    );
    const row = result.rows.at(0);
    if (!row) {
      throw new BranchOperationError(
        'BRANCH_NOT_AVAILABLE',
        'La sucursal no está disponible en la organización.',
      );
    }
    if (row.status !== 'ACTIVE') {
      throw new BranchOperationError(
        'BRANCH_INACTIVE',
        'La sucursal está inactiva y no admite nuevas operaciones.',
      );
    }
    return { id: row.id, status: 'ACTIVE', version: row.version };
  }
}
