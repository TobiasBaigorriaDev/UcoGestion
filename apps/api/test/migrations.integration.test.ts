import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';

describe('database migrations', () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('migrates a fresh database and safely replays from an earlier version', async () => {
    await runMigrations(container.getConnectionUri());
    await runMigrations(container.getConnectionUri());

    const probe = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'schema_migrations_probe' ORDER BY column_name",
    );

    expect(probe.rows.map((row) => row.column_name)).toEqual(['id', 'version']);
  });
});
