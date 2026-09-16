import type { Pool, PoolClient } from 'pg';

export interface TenantTransactionContext {
  readonly organizationId: string;
  readonly requestId: string;
  readonly userId: string;
}

export class TenantTransaction {
  constructor(private readonly pool: Pool) {}

  async run<TResult>(
    context: TenantTransactionContext,
    operation: (client: PoolClient) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [context.organizationId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId]);
      await client.query("SELECT set_config('app.request_id', $1, true)", [context.requestId]);

      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
