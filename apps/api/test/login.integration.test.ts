import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { InvalidCredentialsError, LoginService } from '../src/modules/auth/login.service.js';

describe('global login', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let login: LoginService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    login = new LoginService(pool);
    await createGlobalUser(pool, {
      email: 'owner@example.com',
      password: 'correct-password',
    });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('issues a fresh 256-bit opaque token and stores only its SHA-256 hash', async () => {
    const first = await login.execute({ email: ' Owner@EXAMPLE.com ', password: 'correct-password' });
    const second = await login.execute({ email: 'owner@example.com', password: 'correct-password' });

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.token).not.toBe(first.token);

    const sessions = await pool.query<{
      token_hash: string;
      user_id: string;
      idle_expires_at: Date;
      absolute_expires_at: Date;
    }>('SELECT token_hash, user_id, idle_expires_at, absolute_expires_at FROM auth_sessions ORDER BY created_at');
    expect(sessions.rows).toHaveLength(2);
    expect(sessions.rows.map((row) => row.token_hash).sort()).toEqual(
      [first.token, second.token]
        .map((token) => createHash('sha256').update(token).digest('hex'))
        .sort(),
    );
    expect(JSON.stringify(sessions.rows)).not.toContain(first.token);
    expect(sessions.rows[0]?.user_id).toBe(sessions.rows[1]?.user_id);
    expect(sessions.rows[0]?.idle_expires_at).toBeInstanceOf(Date);
    expect(sessions.rows[0]?.absolute_expires_at).toBeInstanceOf(Date);
  });

  it('returns the same public failure for an unknown email and a wrong password without creating a session', async () => {
    const before = await pool.query<{ count: string }>('SELECT count(*) FROM auth_sessions');
    const missing = await login.execute({ email: 'missing@example.com', password: 'wrong-password' }).catch((error: unknown) => error);
    const wrong = await login.execute({ email: 'owner@example.com', password: 'wrong-password' }).catch((error: unknown) => error);
    const after = await pool.query<{ count: string }>('SELECT count(*) FROM auth_sessions');

    if (!(missing instanceof InvalidCredentialsError) || !(wrong instanceof InvalidCredentialsError)) {
      throw new Error('Invalid login did not return the expected error');
    }
    expect({ code: missing.code, message: missing.message }).toEqual({ code: wrong.code, message: wrong.message });
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
