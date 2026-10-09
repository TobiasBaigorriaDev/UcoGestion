import { afterEach, expect, it, vi } from 'vitest';
import { deactivateBranch } from '../src/features/identity/branch-deactivation';
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
it('preserves exact version, body and idempotency key after a lost response', async () => {
  const attempts: { key: string | null; version: string | null; body: BodyInit | null | undefined }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url).endsWith('/csrf')) return Response.json({ csrfToken: 'csrf' });
    const headers = new Headers(options?.headers);
    attempts.push({ key: headers.get('Idempotency-Key'), version: headers.get('If-Match'), body: options?.body });
    if (attempts.length === 1) throw new Error('Lost response after commit');
    return Response.json({ id: 'branch', name: 'Principal', status: 'INACTIVE', version: 2 });
  });
  await expect(deactivateBranch('org', 'branch', 1)).rejects.toThrow();
  expect((await deactivateBranch('org', 'branch', 1)).status).toBe('INACTIVE');
  expect(attempts[0]).toEqual(attempts[1]);
  expect(attempts[0]?.version).toBe('"1"');
  expect(attempts[0]?.key).toBeTruthy();
  expect(localStorage.length).toBe(0);
});
