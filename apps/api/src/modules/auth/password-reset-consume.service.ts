import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import { hashPassword } from './password.js';

interface PasswordResetConsumeInput {
  readonly password: string;
  readonly token: string;
}

interface ResetTokenRow {
  readonly id: string;
  readonly user_id: string;
}

export class InvalidPasswordResetTokenError extends Error {
  readonly code = 'PASSWORD_RESET_TOKEN_INVALID';

  constructor() {
    super('El enlace de recuperación no es válido o venció.');
    this.name = 'InvalidPasswordResetTokenError';
  }
}

export class PasswordResetConsumeService {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  async execute(input: PasswordResetConsumeInput): Promise<{ readonly reset: true }> {
    const replacement = await hashPassword(input.password);
    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ResetTokenRow>(
        `SELECT id, user_id
         FROM password_reset_tokens
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > clock_timestamp()
         FOR UPDATE`,
        [tokenHash],
      );
      const reset = result.rows[0];
      if (!reset) throw new InvalidPasswordResetTokenError();

      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [reset.user_id]);
      await client.query(
        'UPDATE users SET password_hash = $1, password_hash_version = $2 WHERE id = $3',
        [replacement.hash, replacement.version, reset.user_id],
      );
      const consumed = await client.query(
        `UPDATE password_reset_tokens SET used_at = clock_timestamp()
         WHERE id = $1 AND used_at IS NULL RETURNING id`,
        [reset.id],
      );
      if (consumed.rowCount !== 1) throw new InvalidPasswordResetTokenError();
      await client.query(
        'UPDATE auth_sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL',
        [reset.user_id],
      );
      await client.query('COMMIT');
      return { reset: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
