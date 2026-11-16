import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';

import { normalizeEmail } from '../../core/security/email-normalization.js';
import { hashPassword } from '../../core/security/password.js';

export { normalizeEmail };

type QueryClient = Pick<Client, 'query'>;

export interface CreateGlobalUserInput {
  email: string;
  password: string;
}

export interface GlobalUserIdentity {
  id: string;
  email: string;
}

export async function createGlobalUser(
  client: QueryClient,
  input: CreateGlobalUserInput,
): Promise<GlobalUserIdentity> {
  const id = randomUUID();
  const email = normalizeEmail(input.email);
  const password = await hashPassword(input.password);

  await client.query(
    'INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, $2, $3, $4)',
    [id, email, password.hash, password.version],
  );

  return { id, email };
}
