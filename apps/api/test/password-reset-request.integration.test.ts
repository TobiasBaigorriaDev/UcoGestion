import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { PasswordResetRequestService } from '../src/modules/auth/password-reset-request.service.js';
import { PostgresRateLimitService } from '../src/modules/auth/postgres-rate-limit.service.js';

describe('password reset request', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let service: PasswordResetRequestService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const rateLimits = new PostgresRateLimitService(pool, {
      limits: { INVITATION: 10, LOGIN: 10, PASSWORD_RESET: 10 },
      pepper: 'password-reset-test-pepper',
      windowSeconds: 300,
    });
    service = new PasswordResetRequestService(pool, rateLimits);
    await createGlobalUser(pool, { email: 'reset@example.com', password: 'old-password' });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('returns the same public result while storing only a hash and an expiring email outbox intent', async () => {
    const known = await service.execute({ email: ' Reset@Example.com ', ipAddress: '203.0.113.20' });
    const missing = await service.execute({ email: 'missing@example.com', ipAddress: '203.0.113.21' });

    expect(known).toEqual(missing);
    expect(known).toEqual({ accepted: true });

    const reset = await pool.query<{
      created_at: Date;
      expires_at: Date;
      token_hash: string;
    }>('SELECT token_hash, expires_at, created_at FROM password_reset_tokens');
    expect(reset.rows).toHaveLength(1);
    const resetRow = reset.rows[0];
    if (!resetRow) throw new Error('Expected one password reset token.');
    expect(resetRow.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(resetRow.expires_at.getTime() - resetRow.created_at.getTime()).toBe(30 * 60 * 1_000);

    const jobs = await pool.query<{ payload: { email: string; token: string }; status: string }>(
      "SELECT payload, status FROM identity_outbox_jobs WHERE job_type = 'PASSWORD_RESET_EMAIL'",
    );
    expect(jobs.rows).toHaveLength(1);
    const job = jobs.rows[0];
    if (!job) throw new Error('Expected one password reset email job.');
    expect(job).toMatchObject({ payload: { email: 'reset@example.com' }, status: 'PENDING' });
    expect(job.payload.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHash('sha256').update(job.payload.token).digest('hex')).toBe(resetRow.token_hash);
    expect(JSON.stringify(reset.rows)).not.toContain(job.payload.token);
  });

  it('rolls back the reset token when the outbox insert fails', async () => {
    await createGlobalUser(pool, { email: 'rollback-reset@example.com', password: 'old-password' });
    await pool.query(`
      CREATE FUNCTION reject_identity_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'simulated outbox failure';
      END;
      $$;
      CREATE TRIGGER reject_identity_outbox_insert
      BEFORE INSERT ON identity_outbox_jobs
      FOR EACH ROW EXECUTE FUNCTION reject_identity_outbox_insert();
    `);

    await expect(
      service.execute({ email: 'rollback-reset@example.com', ipAddress: '203.0.113.22' }),
    ).rejects.toThrow('simulated outbox failure');
    const reset = await pool.query<{ count: string }>(
      `SELECT count(*) FROM password_reset_tokens AS tokens
       JOIN users ON users.id = tokens.user_id
       WHERE users.email_normalized = 'rollback-reset@example.com'`,
    );
    expect(reset.rows[0]?.count).toBe('0');

    await pool.query('DROP TRIGGER reject_identity_outbox_insert ON identity_outbox_jobs');
    await pool.query('DROP FUNCTION reject_identity_outbox_insert()');
  });
});
