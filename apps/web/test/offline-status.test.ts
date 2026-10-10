import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { actor, org, device } from './offline-authorization.fixture';
import { posFixture, register } from './offline-pos.fixture';
import { readOfflineStatus } from '../src/offline/offline-status';
import { OfflineKeys } from '../src/offline/offline-keys';

afterEach(() => Dexie.delete(`uconext-offline-${org}-${device}`));
it('T220A returns verified validity, last sync and only the active identity encrypted queue', async () => {
  const setup = await posFixture();
  const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
  await setup.db.putEncrypted('another-user', 'operation', 'secret-id', new Uint8Array([99]));
  const status = await readOfflineStatus(setup.db, setup.keys, setup.authorization, actor);
  expect(status.pending).toEqual([{ id: opened.operationId, kind: 'cash-session-open', sequence: '1', occurredAt: expect.any(String) }]);
  expect(status.lastSyncAt).toBe(setup.bootstrap.serverTime);
  expect(status.timezone).toBe(setup.bootstrap.timezone);
  expect(status.expiresAt).toBe(new Date(setup.claims.exp * 1000).toISOString());
  setup.keys.lock();
  await expect(readOfflineStatus(setup.db, setup.keys, setup.authorization, actor)).rejects.toThrow();
  const other = new OfflineKeys(setup.db);
  await other.create('another-user', 'another-pin');
  await expect(readOfflineStatus(setup.db, other, setup.authorization, actor)).rejects.toThrow();
  setup.db.close();
});
