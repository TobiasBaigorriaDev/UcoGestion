import { argon2id, hash, verify } from 'argon2';

export const PASSWORD_HASH_VERSION = 1;

export interface PasswordHash {
  hash: string;
  version: number;
}

const passwordHashParameters = {
  type: argon2id,
  version: 0x13,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

export async function hashPassword(password: string): Promise<PasswordHash> {
  return {
    hash: await hash(password, passwordHashParameters),
    version: PASSWORD_HASH_VERSION,
  };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  if (stored.version !== PASSWORD_HASH_VERSION || !stored.hash.startsWith('$argon2id$v=19$')) {
    return false;
  }

  return verify(stored.hash, password);
}
