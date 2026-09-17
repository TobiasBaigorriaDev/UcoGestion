import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

type SessionDatabase = Pick<Pool, 'query'>;

export class SessionRevocationService {
  constructor(private readonly database: SessionDatabase) {}

  async revokeToken(token: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.database.query(
      'UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash],
    );
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.database.query(
      'UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
  }
}
