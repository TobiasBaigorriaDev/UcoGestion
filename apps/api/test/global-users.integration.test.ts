import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { hashPassword, PASSWORD_HASH_VERSION, verifyPassword } from '../src/modules/auth/password.js';

describe('global users', () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

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

  it('stores a global normalized email and a versioned Argon2id hash, never the password', async () => {
    const password = 'private-test-password';
    const user = await createGlobalUser(client, {
      email: '  Owner@Example.COM  ',
      password,
    });

    const result = await client.query<{
      email_normalized: string;
      password_hash: string;
      password_hash_version: number;
      created_at: Date;
    }>('SELECT email_normalized, password_hash, password_hash_version, created_at FROM users WHERE id = $1', [user.id]);

    expect(user).toEqual({ id: expect.any(String), email: 'owner@example.com' });
    expect(result.rows[0]).toMatchObject({
      email_normalized: 'owner@example.com',
      password_hash_version: PASSWORD_HASH_VERSION,
      created_at: expect.any(Date),
    });
    const stored = result.rows[0];
    if (!stored) throw new Error('User was not persisted');
    expect(stored.password_hash).toMatch(/^\$argon2id\$v=19\$m=\d+,p=\d+,t=\d+\$/);
    expect(stored.password_hash).not.toContain(password);
    const credentials = { hash: stored.password_hash, version: stored.password_hash_version };
    expect(await verifyPassword(password, credentials)).toBe(true);
    expect(await verifyPassword('wrong-password', credentials)).toBe(false);

    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'organization_id'",
    );
    expect(columns.rows).toHaveLength(0);
  });

  it('enforces email uniqueness globally after normalization', async () => {
    await createGlobalUser(client, { email: '  UNIQUE@Example.com ', password: 'another-test-password' });

    await expect(
      createGlobalUser(client, { email: 'unique@example.COM', password: 'third-test-password' }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects unnormalized email and plaintext or unversioned password storage', async () => {
    const passwordHash = await hashPassword('constraint-test-password');
    await expect(
      client.query(
        "INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ('00000000-0000-4000-8000-000000000029', ' Mixed@Example.com ', $1, 1)",
        [passwordHash.hash],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query(
        "INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ('00000000-0000-4000-8000-000000000030', 'plain@example.com', 'plaintext', 1)",
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query(
        "INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ('00000000-0000-4000-8000-000000000031', 'old@example.com', $1, 0)",
        [passwordHash.hash],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
