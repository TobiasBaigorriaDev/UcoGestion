import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';

import { hashPassword } from './password.js';

type QueryClient = Pick<Client, 'query'>;

export interface CreateGlobalUserInput {
  email: string;
  password: string;
}

export interface GlobalUserIdentity {
  id: string;
  email: string;
}

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Email cannot be empty');
  }
  return normalized;
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
