import { createHmac } from 'node:crypto';

import type { Pool } from 'pg';

export type PublicRateLimitScope = 'INVITATION' | 'LOGIN' | 'PASSWORD_RESET';

export interface RateLimitRequest {
  readonly identity: string;
  readonly ipAddress: string;
  readonly scope: PublicRateLimitScope;
}

export interface PostgresRateLimitOptions {
  readonly limits: Readonly<Record<PublicRateLimitScope, number>>;
  readonly pepper: string;
  readonly windowSeconds: number;
}

interface RateLimitRow {
  attempts: number;
  retry_after_seconds: number;
}

export class RateLimitExceededError extends Error {
  readonly code = 'RATE_LIMITED';

  constructor(readonly retryAfterSeconds: number) {
    super('Demasiados intentos. Esperá unos minutos antes de volver a intentar.');
    this.name = 'RateLimitExceededError';
  }
}

export class PostgresRateLimitService {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly options: PostgresRateLimitOptions,
  ) {
    if (options.windowSeconds < 1 || Object.values(options.limits).some((limit) => limit < 1)) {
      throw new Error('Rate-limit windows and limits must be positive.');
    }
    if (options.pepper.length < 16) {
      throw new Error('RATE_LIMIT_PEPPER must contain at least 16 characters.');
    }
  }

  async consume(request: RateLimitRequest): Promise<void> {
    const identityHash = this.hash(request.identity.trim().toLowerCase());
    const ipHash = this.hash(request.ipAddress.trim().toLowerCase());
    const result = await this.pool.query<RateLimitRow>(
      `INSERT INTO security_rate_limits (
        scope, identity_hash, ip_hash, window_started_at, attempts, updated_at
      ) VALUES ($1, $2, $3, clock_timestamp(), 1, clock_timestamp())
      ON CONFLICT (scope, identity_hash, ip_hash) DO UPDATE
      SET attempts = CASE
          WHEN security_rate_limits.window_started_at <= clock_timestamp() - ($4 * interval '1 second') THEN 1
          ELSE security_rate_limits.attempts + 1
        END,
        window_started_at = CASE
          WHEN security_rate_limits.window_started_at <= clock_timestamp() - ($4 * interval '1 second')
            THEN clock_timestamp()
          ELSE security_rate_limits.window_started_at
        END,
        updated_at = clock_timestamp()
      RETURNING attempts,
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
          window_started_at + ($4 * interval '1 second') - clock_timestamp()
        ))))::integer AS retry_after_seconds`,
      [request.scope, identityHash, ipHash, this.options.windowSeconds],
    );
    const row = result.rows[0];
    if (!row) throw new Error('The rate-limit counter was not persisted.');
    if (row.attempts > this.options.limits[request.scope]) {
      throw new RateLimitExceededError(row.retry_after_seconds);
    }
  }

  private hash(value: string): string {
    return createHmac('sha256', this.options.pepper).update(value).digest('hex');
  }
}
