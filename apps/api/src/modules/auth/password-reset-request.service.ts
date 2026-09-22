import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { normalizeEmail } from './global-user.repository.js';
import type { PostgresRateLimitService } from './postgres-rate-limit.service.js';

interface PasswordResetRequest {
  readonly email: string;
  readonly ipAddress: string;
}

export interface PasswordResetRequestResult {
  readonly accepted: true;
}

interface ResettableUser {
  readonly disabled_at: Date | null;
  readonly email_normalized: string;
  readonly id: string;
}

export class PasswordResetRequestService {
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly rateLimits: PostgresRateLimitService,
  ) {}

  async execute(input: PasswordResetRequest): Promise<PasswordResetRequestResult> {
    const email = normalizeEmail(input.email);
    await this.rateLimits.consume({
      identity: email,
      ipAddress: input.ipAddress,
      scope: 'PASSWORD_RESET',
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ResettableUser>(
        `SELECT id, email_normalized, disabled_at
         FROM users
         WHERE email_normalized = $1
         FOR UPDATE`,
        [email],
      );
      const user = result.rows[0];
      if (user && user.disabled_at === null) {
        const token = randomBytes(32).toString('base64url');
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const resetId = randomUUID();
        await client.query(
          `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
           VALUES ($1, $2, $3, now() + interval '30 minutes')`,
          [resetId, user.id, tokenHash],
        );
        await client.query(
          `INSERT INTO identity_outbox_jobs (id, job_key, job_type, payload)
           VALUES ($1, $2, 'PASSWORD_RESET_EMAIL', $3::jsonb)`,
          [randomUUID(), `password-reset:${resetId}`, JSON.stringify({ email: user.email_normalized, token })],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return { accepted: true };
  }
}
