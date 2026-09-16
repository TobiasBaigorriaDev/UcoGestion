import { describe, expect, it } from 'vitest';

import { hashPassword, PASSWORD_HASH_VERSION, verifyPassword } from '../src/modules/auth/password.js';

describe('versioned password hashing', () => {
  it('uses a fresh salt for each Argon2id hash and verifies only the matching password', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');

    expect(first.version).toBe(PASSWORD_HASH_VERSION);
    expect(first.hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(first.hash).not.toBe(second.hash);
    expect(await verifyPassword('same-password', first)).toBe(true);
    expect(await verifyPassword('not-the-password', first)).toBe(false);
    expect(await verifyPassword('same-password', { ...first, version: 999 })).toBe(false);
  });
});
