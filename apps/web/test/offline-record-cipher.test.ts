import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OfflineRecordCipher } from '../src/offline/offline-record-cipher.js';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const context = { organizationId: 'tenant', deviceId: 'device', userId: 'alice', kind: 'operation', id: 'id' };
describe('T190 identity record encryption', () => {
  it('uses unique IVs, authenticates every identity/context field and rejects altered ciphertext', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const cipher = new OfflineRecordCipher();
    const bytes = new TextEncoder().encode('private payload');
    const first = await cipher.encrypt(key, context, bytes);
    const second = await cipher.encrypt(key, context, bytes);
    expect(first).not.toEqual(second);
    expect(new TextDecoder().decode(await cipher.decrypt(key, context, first))).toBe('private payload');
    for (const field of Object.keys(context)) {
      await expect(cipher.decrypt(key, { ...context, [field]: 'other' }, first)).rejects.toThrow();
    }
    const changed = first.slice();
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    await expect(cipher.decrypt(key, context, changed)).rejects.toThrow();
    const otherKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await expect(cipher.decrypt(otherKey, context, first)).rejects.toThrow();
    await expect(cipher.decrypt(key, context, new Uint8Array([2]))).rejects.toThrow();
    const weakKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']);
    await expect(cipher.encrypt(weakKey, context, bytes)).rejects.toThrow(/AES-256/);
  });
});
