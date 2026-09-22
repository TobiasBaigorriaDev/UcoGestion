import type { PoolClient } from 'pg';

export interface ServerHistoryPredicate {
  lockAndCheck(client: PoolClient, organizationId: string): Promise<boolean>;
}

export class OrganizationHistoryScopeError extends Error {
  readonly code = 'ORGANIZATION_HISTORY_SCOPE_INVALID';

  constructor() {
    super('La organización no pertenece al contexto tenant activo.');
    this.name = 'OrganizationHistoryScopeError';
  }
}

export class PostgresServerHistoryPredicate implements ServerHistoryPredicate {
  async lockAndCheck(client: PoolClient, organizationId: string): Promise<boolean> {
    const result = await client.query<{ operational_history_started_at: Date | null }>(
      `SELECT operational_history_started_at
       FROM organizations
       WHERE id = $1
       FOR UPDATE`,
      [organizationId],
    );
    const row = result.rows[0];
    if (!row) throw new OrganizationHistoryScopeError();
    return row.operational_history_started_at !== null;
  }
}
