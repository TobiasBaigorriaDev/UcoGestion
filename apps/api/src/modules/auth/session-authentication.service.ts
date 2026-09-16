import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

type GlobalIdentityDatabase = Pick<Pool, 'query'>;

export interface SessionIdentity {
  readonly userId: string;
}

export class SessionAuthenticationService {
  constructor(private readonly database: GlobalIdentityDatabase) {}

  async authenticate(token: string): Promise<SessionIdentity | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return null;
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const result = await this.database.query<{ user_id: string }>(
      `UPDATE auth_sessions
       SET idle_expires_at = LEAST(now() + interval '12 hours', absolute_expires_at)
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND idle_expires_at > now()
         AND absolute_expires_at > now()
       RETURNING user_id`,
      [tokenHash],
    );
    const session = result.rows[0];
    return session ? { userId: session.user_id } : null;
  }
}
