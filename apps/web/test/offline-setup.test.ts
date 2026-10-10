import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authorizationFixture, actor, branch, org, device, now } from './offline-authorization.fixture';
import { OfflineSetup } from '../src/offline/offline-setup';
import { OfflineDatabase } from '../src/offline/offline-database';

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); await Dexie.delete(`uconext-offline-${org}-${device}`); await Dexie.delete(`uconext-offline-${org}-${branch}`); });
it('T220A refresh requires complete opaque synchronization and installs a verified grant without changing the PIN', async () => {
  const fixture = await authorizationFixture();
  await fixture.authorization.install(actor, fixture.signed, fixture.jwt());
  const controller = new OfflineSetup(fixture.db, actor, branch, true, true);
  await controller.unlock('offline-pin');
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    requests.push(String(input));
    if (String(input).endsWith('/csrf')) return Response.json({ csrfToken: 'csrf' });
    expect(new Headers(init?.headers).get('X-Organization-Id')).toBe(org);
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBeTruthy();
    if (String(input).endsWith('/bootstrap')) return Response.json(fixture.signed);
    return Response.json({ grant: fixture.jwt() });
  });
  expect((await controller.refresh()).lastSyncAt).toBe(fixture.bootstrap.serverTime);
  expect(requests).toEqual(['/api/v1/auth/csrf', '/api/v1/offline/bootstrap', '/api/v1/auth/csrf', '/api/v1/offline/authorize']);
  controller.lock();
  expect((await controller.unlock('offline-pin')).pending).toEqual([]);
  controller.close();
});
it('T220A response loss retains the exact grant proof and idempotency key for retry', async () => {
  const fixture = await authorizationFixture();
  await fixture.authorization.install(actor, fixture.signed, fixture.jwt());
  const controller = new OfflineSetup(fixture.db, actor, branch, true, true);
  await controller.unlock('offline-pin');
  const attempts: { body: string; key: string | null }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/csrf')) return Response.json({ csrfToken: 'csrf' });
    if (String(input).endsWith('/bootstrap')) return Response.json(fixture.signed);
    attempts.push({ body: String(init?.body), key: new Headers(init?.headers).get('Idempotency-Key') });
    if (attempts.length === 1) throw new Error('Lost grant response');
    return Response.json({ grant: fixture.jwt() });
  });
  await expect(controller.refresh()).rejects.toThrow();
  await controller.refresh();
  expect(attempts[0]).toEqual(attempts[1]);
  controller.close();
});

it('registers a new device with the same PIN wrapping and exact request after response loss', async () => {
  const fixture = await authorizationFixture(); await fixture.db.delete();
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  vi.stubGlobal('navigator', { onLine: true, serviceWorker: { getRegistration: async () => undefined, register: async () => ({ active: true }) } });
  const stage = new OfflineDatabase(org, branch);
  const setup = new OfflineSetup(stage, actor, branch, false, false);
  const registrations: { body: string; key: string | null }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/csrf')) return Response.json({ csrfToken: 'csrf' });
    if (String(input).endsWith('/authorize-pos')) {
      registrations.push({ body: String(init?.body), key: new Headers(init?.headers).get('Idempotency-Key') });
      if (registrations.length === 1) throw new Error('Registration committed but response lost');
      return Response.json({ id: device, organizationId: org, branchId: branch, authorizedByUserId: actor, status: 'ACTIVE', thumbprint: 'fixture', certificate: 'signed-device-certificate' });
    }
    if (String(input).endsWith('/bootstrap')) return Response.json(fixture.signed);
    const db = new OfflineDatabase(org, device);
    const key = (await db.device_keys.get('device'))?.publicKey; if (!key) throw new Error('Missing copied key');
    const spki = await crypto.subtle.exportKey('spki', key); db.close();
    return Response.json({ grant: fixture.jwt({ ...fixture.claims, thumbprint: createHash('sha256').update(Buffer.from(spki)).digest('base64url') }) });
  });
  await expect(setup.authorize('new-offline-pin')).rejects.toThrow();
  const wrapped = await stage.key_envelopes.get(actor);
  await setup.authorize('new-offline-pin');
  expect(registrations[0]).toEqual(registrations[1]);
  const final = new OfflineDatabase(org, device);
  expect(await final.key_envelopes.get(actor)).toEqual(wrapped);
  expect((await final.device_keys.get('device'))?.certificate).toBe('signed-device-certificate');
  expect(await Dexie.exists(stage.name)).toBe(false);
  setup.lock(); expect((await setup.unlock('new-offline-pin')).pending).toEqual([]);
  setup.close(); final.close();
});
