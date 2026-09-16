import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { LoginService } from '../src/modules/auth/login.service.js';
import { SessionAuthenticationService } from '../src/modules/auth/session-authentication.service.js';

describe('session expiration', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let login: LoginService;
  let sessions: SessionAuthenticationService;
  let userId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    login = new LoginService(pool);
    sessions = new SessionAuthenticationService(pool);
    userId = (await createGlobalUser(pool, {
      email: 'expiration@example.com',
      password: 'correct-password',
    })).id;
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('refreshes idle expiration on use without extending beyond the absolute deadline', async () => {
    const { token } = await login.execute({ email: 'expiration@example.com', password: 'correct-password' });
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await pool.query(
      `UPDATE auth_sessions
       SET idle_expires_at = now() + interval '1 minute',
           absolute_expires_at = now() + interval '2 hours'
       WHERE token_hash = $1`,
      [tokenHash],
    );

    expect(await sessions.authenticate(token)).toEqual({ userId });
    const result = await pool.query<{ idle_expires_at: Date; absolute_expires_at: Date }>(
      'SELECT idle_expires_at, absolute_expires_at FROM auth_sessions WHERE token_hash = $1',
      [tokenHash],
    );
    expect(result.rows[0]?.idle_expires_at.getTime()).toBe(result.rows[0]?.absolute_expires_at.getTime());
  });

  it('rejects an idle-expired session without renewing it', async () => {
    const { token } = await login.execute({ email: 'expiration@example.com', password: 'correct-password' });
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await pool.query(
      `UPDATE auth_sessions
       SET created_at = now() - interval '2 days',
           idle_expires_at = now() - interval '1 minute'
       WHERE token_hash = $1`,
      [tokenHash],
    );

    expect(await sessions.authenticate(token)).toBeNull();
    const result = await pool.query<{ expired: boolean }>(
      'SELECT idle_expires_at <= now() AS expired FROM auth_sessions WHERE token_hash = $1',
      [tokenHash],
    );
    expect(result.rows[0]?.expired).toBe(true);
  });

  it('rejects an absolutely expired session even if the token is intact', async () => {
    const { token } = await login.execute({ email: 'expiration@example.com', password: 'correct-password' });
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await pool.query(
      `UPDATE auth_sessions
       SET created_at = now() - interval '8 days',
           idle_expires_at = now() - interval '2 hours',
           absolute_expires_at = now() - interval '1 hour'
       WHERE token_hash = $1`,
      [tokenHash],
    );

    expect(await sessions.authenticate(token)).toBeNull();
    expect(await sessions.authenticate('invalid-token')).toBeNull();
  });
});
