import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { argon2id, hash } from 'argon2';
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

  it('transparently upgrades an older Argon2id cost after valid password authentication', async () => {
    const user = await createGlobalUser(pool, {
      email: 'rehash@example.com',
      password: 'upgrade-password',
    });
    const oldHash = await hash('upgrade-password', {
      type: argon2id,
      version: 0x13,
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
    });
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [oldHash, user.id]);

    await expect(login.execute({ email: user.email, password: 'wrong-password' })).rejects.toBeInstanceOf(InvalidCredentialsError);
    const before = await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    expect(before.rows[0]?.password_hash).toBe(oldHash);

    await login.execute({ email: user.email, password: 'upgrade-password' });
    const after = await pool.query<{ password_hash: string; password_hash_version: number }>(
      'SELECT password_hash, password_hash_version FROM users WHERE id = $1',
      [user.id],
    );
    expect(after.rows[0]?.password_hash).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    expect(after.rows[0]?.password_hash).not.toBe(oldHash);
    expect(after.rows[0]?.password_hash_version).toBe(1);
  });
});
