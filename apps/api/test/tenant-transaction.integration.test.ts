import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantTransaction } from '../src/database/tenant-transaction.js';

describe('TenantTransaction', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query('CREATE TABLE tenant_transaction_probe (id integer PRIMARY KEY)');
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('sets local context and rolls back while returning its client to the pool', async () => {
    const transactions = new TenantTransaction(pool);

    await expect(
      transactions.run(
        {
          organizationId: '00000000-0000-4000-8000-000000000001',
          requestId: 'request-1',
          userId: '00000000-0000-4000-8000-000000000002',
        },
        async (client) => {
          const context = await client.query<{ organization_id: string }>(
            "SELECT current_setting('app.organization_id') AS organization_id",
          );
          expect(context.rows[0]?.organization_id).toBe('00000000-0000-4000-8000-000000000001');
          await client.query('INSERT INTO tenant_transaction_probe (id) VALUES (1)');
          throw new Error('rollback');
        },
      ),
    ).rejects.toThrow('rollback');

    expect(await pool.query('SELECT count(*)::integer AS count FROM tenant_transaction_probe')).toMatchObject({
      rows: [{ count: 0 }],
    });
    expect(pool.idleCount).toBe(1);
  });
});
