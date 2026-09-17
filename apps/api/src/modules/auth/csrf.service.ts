import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Pool } from 'pg';

type SessionDatabase = Pick<Pool, 'query'>;

export class CsrfService {
  constructor(private readonly database: SessionDatabase) {}

  async issue(sessionToken: string): Promise<string | null> {
    if (!isToken(sessionToken)) return null;
    const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
    const newCsrfToken = randomBytes(32).toString('base64url');
    const result = await this.database.query<{ csrf_token: string }>(
      `UPDATE auth_sessions
       SET csrf_token = COALESCE(csrf_token, $2),
           idle_expires_at = LEAST(now() + interval '12 hours', absolute_expires_at)
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND idle_expires_at > now()
         AND absolute_expires_at > now()
         AND EXISTS (
           SELECT 1 FROM users
           WHERE users.id = auth_sessions.user_id AND users.disabled_at IS NULL
         )
       RETURNING csrf_token`,
      [tokenHash, newCsrfToken],
    );
    return result.rows[0]?.csrf_token ?? null;
  }

  async verify(sessionToken: string, candidate: string): Promise<boolean> {
    if (!isToken(sessionToken) || !isToken(candidate)) return false;
    const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
    const result = await this.database.query<{ csrf_token: string }>(
      `UPDATE auth_sessions
       SET idle_expires_at = LEAST(now() + interval '12 hours', absolute_expires_at)
       WHERE token_hash = $1
         AND csrf_token IS NOT NULL
         AND revoked_at IS NULL
         AND idle_expires_at > now()
         AND absolute_expires_at > now()
         AND EXISTS (
           SELECT 1 FROM users
           WHERE users.id = auth_sessions.user_id AND users.disabled_at IS NULL
         )
       RETURNING csrf_token`,
      [tokenHash],
    );
    const expected = result.rows[0]?.csrf_token;
    return expected !== undefined && timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  }
}

function isToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
