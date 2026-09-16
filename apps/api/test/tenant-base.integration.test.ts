import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';

describe('tenant base tables', () => {
  let client: Client;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('uses UUID and UTC timestamps in tenant tables', async () => {
    const columns = await client.query<{ column_name: string; data_type: string }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'branches' AND column_name IN ('id', 'organization_id', 'created_at') ORDER BY column_name",
    );

    expect(columns.rows).toEqual([
      { column_name: 'created_at', data_type: 'timestamp with time zone' },
      { column_name: 'id', data_type: 'uuid' },
      { column_name: 'organization_id', data_type: 'uuid' },
    ]);
  });

  it('rejects a tenant relationship that crosses organizations', async () => {
    await client.query(
      "INSERT INTO organizations (id, base_currency, timezone) VALUES ('00000000-0000-4000-8000-000000000001', 'ARS', 'America/Argentina/Mendoza'), ('00000000-0000-4000-8000-000000000002', 'ARS', 'America/Argentina/Mendoza')",
    );
    await client.query(
      "INSERT INTO branches (id, organization_id, name) VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'Centro')",
    );

    await expect(
      client.query(
        "INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'Principal')",
      ),
    ).rejects.toThrow();
  });
});
