import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { InvalidCredentialsError, LoginService } from '../src/modules/auth/login.service.js';
import {
  InvalidPasswordResetTokenError,
  PasswordResetConsumeService,
} from '../src/modules/auth/password-reset-consume.service.js';
import { PasswordResetRequestService } from '../src/modules/auth/password-reset-request.service.js';
import { PostgresRateLimitService } from '../src/modules/auth/postgres-rate-limit.service.js';

describe('password reset consumption', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let consumeReset: PasswordResetConsumeService;
  let requestReset: PasswordResetRequestService;
  let login: LoginService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    requestReset = new PasswordResetRequestService(
      pool,
      new PostgresRateLimitService(pool, {
        limits: { INVITATION: 20, LOGIN: 20, PASSWORD_RESET: 20 },
        pepper: 'password-reset-consume-test',
        windowSeconds: 300,
      }),
    );
    consumeReset = new PasswordResetConsumeService(pool);
    login = new LoginService(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('changes the password once and revokes every active session atomically', async () => {
    const user = await createGlobalUser(pool, { email: 'consume@example.com', password: 'old-password' });
    await login.execute({ email: user.email, password: 'old-password' });
    await login.execute({ email: user.email, password: 'old-password' });
    await requestReset.execute({ email: user.email, ipAddress: '203.0.113.30' });
    const token = await latestResetToken(pool, user.email);

    await expect(consumeReset.execute({ password: 'new-secure-password', token })).resolves.toEqual({ reset: true });

    const sessions = await pool.query<{ active: string; revoked: string }>(
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::text AS active,
        count(*) FILTER (WHERE revoked_at IS NOT NULL)::text AS revoked
       FROM auth_sessions WHERE user_id = $1`,
      [user.id],
    );
    expect(sessions.rows[0]).toEqual({ active: '0', revoked: '2' });
    expect(await login.execute({ email: user.email, password: 'old-password' }).catch((error: unknown) => error))
      .toBeInstanceOf(InvalidCredentialsError);
    await expect(login.execute({ email: user.email, password: 'new-secure-password' })).resolves.toHaveProperty('token');
    await expect(consumeReset.execute({ password: 'another-password', token }))
      .rejects.toBeInstanceOf(InvalidPasswordResetTokenError);
  });

  it('returns the same error for expired and unknown tokens without changing the password', async () => {
    const user = await createGlobalUser(pool, { email: 'expired@example.com', password: 'old-password' });
    await requestReset.execute({ email: user.email, ipAddress: '203.0.113.31' });
    const token = await latestResetToken(pool, user.email);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await pool.query(
      `UPDATE password_reset_tokens
       SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
       WHERE token_hash = $1`,
      [tokenHash],
    );

    const expired = await consumeReset.execute({ password: 'new-secure-password', token }).catch((error: unknown) => error);
    const unknown = await consumeReset
      .execute({ password: 'new-secure-password', token: 'unknown-reset-token' })
      .catch((error: unknown) => error);

    expect(expired).toBeInstanceOf(InvalidPasswordResetTokenError);
    expect(unknown).toBeInstanceOf(InvalidPasswordResetTokenError);
    if (!(expired instanceof InvalidPasswordResetTokenError) || !(unknown instanceof InvalidPasswordResetTokenError)) {
      throw new Error('Expected stable password-reset token errors.');
    }
    expect({ code: expired.code, message: expired.message }).toEqual({ code: unknown.code, message: unknown.message });
    await expect(login.execute({ email: user.email, password: 'old-password' })).resolves.toHaveProperty('token');
  });
});

async function latestResetToken(pool: Pool, email: string): Promise<string> {
  const result = await pool.query<{ token: string }>(
    `SELECT payload->>'token' AS token FROM identity_outbox_jobs
     WHERE payload->>'email' = $1 ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  const token = result.rows[0]?.token;
  if (!token) throw new Error('Expected a password reset token in the email outbox.');
  return token;
}
