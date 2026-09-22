import { readFile } from 'node:fs/promises';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import {
  PostgresRateLimitService,
  RateLimitExceededError,
} from '../src/modules/auth/postgres-rate-limit.service.js';

describe('persistent public authentication rate limits', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let rateLimits: PostgresRateLimitService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    rateLimits = new PostgresRateLimitService(pool, {
      limits: { INVITATION: 2, LOGIN: 2, PASSWORD_RESET: 2 },
      pepper: 'integration-test-rate-limit-pepper',
      windowSeconds: 300,
    });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('atomically limits a normalized identity and IP without storing either value', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        rateLimits.consume({
          identity: ' Owner@Example.COM ',
          ipAddress: '203.0.113.9',
          scope: 'LOGIN' as const,
        }),
      ),
    );

    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const rejected = attempts.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(2);
    expect(rejected.every((result) => result.reason instanceof RateLimitExceededError)).toBe(true);

    const stored = await pool.query<{
      attempts: number;
      identity_hash: string;
      ip_hash: string;
    }>('SELECT attempts, identity_hash, ip_hash FROM security_rate_limits');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.attempts).toBe(4);
    expect(stored.rows[0]?.identity_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.rows)).not.toContain('owner@example.com');
    expect(JSON.stringify(stored.rows)).not.toContain('203.0.113.9');
  });

  it('uses the same public throttle for existing and unknown identities while isolating scopes', async () => {
    const known = new PostgresRateLimitService(pool, {
      limits: { INVITATION: 1, LOGIN: 1, PASSWORD_RESET: 1 },
      pepper: 'known-and-unknown',
      windowSeconds: 300,
    });

    await known.consume({ identity: 'known@example.com', ipAddress: '198.51.100.7', scope: 'PASSWORD_RESET' });
    const knownFailure = await known
      .consume({ identity: 'KNOWN@example.com', ipAddress: '198.51.100.7', scope: 'PASSWORD_RESET' })
      .catch((error: unknown) => error);
    await known.consume({ identity: 'known@example.com', ipAddress: '198.51.100.7', scope: 'INVITATION' });

    await known.consume({ identity: 'missing@example.com', ipAddress: '198.51.100.8', scope: 'PASSWORD_RESET' });
    const missingFailure = await known
      .consume({ identity: 'missing@example.com', ipAddress: '198.51.100.8', scope: 'PASSWORD_RESET' })
      .catch((error: unknown) => error);

    expect(knownFailure).toBeInstanceOf(RateLimitExceededError);
    expect(missingFailure).toBeInstanceOf(RateLimitExceededError);
    if (!(knownFailure instanceof RateLimitExceededError) || !(missingFailure instanceof RateLimitExceededError)) {
      throw new Error('Both identities must receive the same rate-limit error.');
    }
    expect({ code: knownFailure.code, message: knownFailure.message }).toEqual({
      code: missingFailure.code,
      message: missingFailure.message,
    });
  });

  it('configures a separate general API limit at the reverse-proxy edge', async () => {
    const config = await readFile(new URL('../../../ops/reverse-proxy/rate-limit.conf', import.meta.url), 'utf8');

    expect(config).toContain('limit_req_zone');
    expect(config).toContain('location /api/');
    expect(config).toContain('limit_req');
  });
});
