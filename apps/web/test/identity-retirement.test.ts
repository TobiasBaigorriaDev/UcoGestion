import { afterEach, expect, it, vi } from 'vitest';
import { login, logout } from '../src/features/identity/auth-flow';
import * as identity from '../src/offline/offline-identity';

afterEach(() => vi.restoreAllMocks());

it('T219 retires local identity before a different online login, even when login fails', async () => {
  const order: string[] = [];
  vi.spyOn(identity, 'retireAllOfflineIdentities').mockImplementation(async () => { order.push('retire'); });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { order.push('login'); throw new Error('Lost network'); });
  await expect(login('b@example.test', 'password')).rejects.toThrow();
  expect(order).toEqual(['retire', 'login']);
});

it('T219 retires offline access before invalidating the online session with CSRF', async () => {
  const order: string[] = [];
  vi.spyOn(identity, 'retireAllOfflineIdentities').mockImplementation(async () => { order.push('retire'); });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    order.push(String(input));
    if (String(input).endsWith('/csrf')) return Response.json({ csrfToken: 'csrf' });
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf');
    expect(init?.credentials).toBe('include');
    return new Response(null, { status: 204 });
  });
  await logout();
  expect(order).toEqual(['retire', '/api/v1/auth/csrf', '/api/v1/auth/logout']);
});
