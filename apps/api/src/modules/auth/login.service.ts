import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { normalizeEmail } from './global-user.repository.js';
import { hashPassword, needsPasswordRehash, verifyPassword } from './password.js';

type GlobalIdentityDatabase = Pick<Pool, 'connect' | 'query'>;

interface LoginInput {
  readonly email: string;
  readonly password: string;
}

interface StoredUser {
  readonly id: string;
  readonly password_hash: string;
  readonly password_hash_version: number;
  readonly disabled_at: Date | null;
}

export interface LoginResult {
  readonly token: string;
}

const dummyPasswordHash = {
  hash: '$argon2id$v=19$m=65536,p=1,t=3$NI20O7nx7YpkLnxkLcdSYQ$rB+21+RrxHfrPa+kbg6jJOMI6ukgUnsKY+xIvuIUJt0',
  version: 1,
};

export class InvalidCredentialsError extends Error {
  readonly code = 'INVALID_CREDENTIALS';

  constructor() {
    super('Correo o contraseña inválidos.');
    this.name = 'InvalidCredentialsError';
  }
}

export class LoginService {
  constructor(private readonly database: GlobalIdentityDatabase) {}

  async execute(input: LoginInput): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const result = await this.database.query<StoredUser>(
      'SELECT id, password_hash, password_hash_version, disabled_at FROM users WHERE email_normalized = $1',
      [email],
    );
    const user = result.rows[0];
    const passwordHash = user
      ? { hash: user.password_hash, version: user.password_hash_version }
      : dummyPasswordHash;

    let passwordMatches = false;
    try {
      passwordMatches = await verifyPassword(input.password, passwordHash);
    } catch {
      // A malformed stored hash must not make account existence observable.
    }
    if (!user || !passwordMatches || user.disabled_at !== null) {
      throw new InvalidCredentialsError();
    }

    const replacementHash = needsPasswordRehash(passwordHash)
      ? await hashPassword(input.password)
      : null;
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<StoredUser>(
        'SELECT id, password_hash, password_hash_version, disabled_at FROM users WHERE id = $1 FOR UPDATE',
        [user.id],
      );
      if (
        locked.rows[0]?.password_hash !== user.password_hash
        || locked.rows[0]?.password_hash_version !== user.password_hash_version
        || locked.rows[0]?.disabled_at !== null
      ) {
        throw new InvalidCredentialsError();
      }
      if (replacementHash) {
        await client.query(
          'UPDATE users SET password_hash = $1, password_hash_version = $2 WHERE id = $3',
          [replacementHash.hash, replacementHash.version, user.id],
        );
      }
      await client.query(
        `INSERT INTO auth_sessions (id, user_id, token_hash, csrf_token, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '12 hours', now() + interval '7 days')`,
        [randomUUID(), user.id, tokenHash, csrfToken],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { token };
  }
}
