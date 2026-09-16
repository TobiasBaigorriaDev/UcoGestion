import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('PostgreSQL transaction integration', () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query(
      'CREATE TABLE rollback_proof (id uuid PRIMARY KEY, description text NOT NULL)',
    );
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('reverts every change when a transaction fails', async () => {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO rollback_proof (id, description) VALUES ('00000000-0000-4000-8000-000000000001', 'must roll back')",
    );
    await client.query('ROLLBACK');

    const result = await client.query<{ count: string }>(
      'SELECT count(*) FROM rollback_proof',
    );

    expect(result.rows[0]?.count).toBe('0');
  });
});
