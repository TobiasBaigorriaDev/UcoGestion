import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { actor, org, device } from './offline-authorization.fixture';
import { posFixture, register } from './offline-pos.fixture';
import { OfflineKeys } from '../src/offline/offline-keys';
import { activateOfflineIdentity, retireOfflineIdentity } from '../src/offline/offline-identity';
import { OpaqueDelivery } from '../src/offline/opaque-delivery';
import { announceIdentityRetirement } from '../src/offline/identity-retirement-events';

afterEach(() => Dexie.delete(`uconext-offline-${org}-${device}`));

it('RF-128 locks credentials on an identity notification without a page-specific observer', async () => {
  const setup = await posFixture();
  const before = await setup.db.deliveryBytes();
  expect(setup.keys.canCreate()).toBe(true);
  announceIdentityRetirement();
  expect(setup.keys.canCreate()).toBe(false);
  expect(() => setup.keys.dekFor(actor)).toThrow();
  expect(await setup.db.deliveryBytes()).toEqual(before);
  setup.db.close();
});

it('T219 retires every in-memory credential and persistent unlock while retaining exact sealed operations', async () => {
  const setup = await posFixture();
  await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
  const second = new OfflineKeys(setup.db);
  await second.unlock(actor, 'offline-pin');
  const before = await setup.db.deliveryBytes();
  const ciphertext = await setup.db.records.toArray();
  await retireOfflineIdentity(setup.db);
  expect(setup.keys.canCreate()).toBe(false);
  expect(second.canCreate()).toBe(false);
  await expect(second.unlock(actor, 'offline-pin')).rejects.toThrow();
  await expect(setup.pos.catalog(actor)).rejects.toThrow();
  await expect(setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' })).rejects.toThrow();
  expect(await setup.db.deliveryBytes()).toEqual(before);
  expect(await setup.db.records.toArray()).toEqual(ciphertext);
  expect((await new OpaqueDelivery(setup.db).signChallenge(new Uint8Array([1]))).length).toBe(64);
  await activateOfflineIdentity(setup.db, actor);
  await second.unlock(actor, 'offline-pin');
  expect(second.canCreate()).toBe(true);
  setup.db.close();
});

it('online session validation cannot reset a blocked PIN without password reauthentication', async () => {
  const setup = await posFixture(); setup.keys.lock();
  await setup.db.pin_attempts.put({ userId: actor, failures: 5, locked: true, retryAfter: 0 });
  await activateOfflineIdentity(setup.db, actor);
  await expect(setup.keys.unlock(actor, 'offline-pin')).rejects.toThrow('PIN bloqueado');
  await activateOfflineIdentity(setup.db, actor, true);
  await setup.keys.unlock(actor, 'offline-pin');
  expect(setup.keys.canCreate()).toBe(true); setup.db.close();
});

it('T219 logout during PIN derivation cannot restore the unlocked DEK', async () => {
  const setup = await posFixture();
  setup.keys.lock();
  const unlock = setup.keys.unlock(actor, 'offline-pin');
  const rejected = expect(unlock).rejects.toThrow();
  await retireOfflineIdentity(setup.db);
  await rejected;
  expect(setup.keys.canCreate()).toBe(false);
  setup.db.close();
});
