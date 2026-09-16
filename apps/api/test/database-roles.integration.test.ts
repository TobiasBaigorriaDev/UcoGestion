import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';

describe('database roles', () => {
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

  it('creates isolated runtime and platform roles without RLS bypass or tenant ownership', async () => {
    const roles = await client.query<{ rolname: string; rolbypassrls: boolean }>(
      "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('uco_app', 'uco_platform') ORDER BY rolname",
    );
    const owners = await client.query<{ tableowner: string }>(
      "SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('branches', 'cash_registers')",
    );

    expect(roles.rows).toEqual([
      { rolbypassrls: false, rolname: 'uco_app' },
      { rolbypassrls: false, rolname: 'uco_platform' },
    ]);
    expect(owners.rows).not.toContainEqual({ tableowner: 'uco_app' });
    expect(owners.rows).not.toContainEqual({ tableowner: 'uco_platform' });
  });
});
