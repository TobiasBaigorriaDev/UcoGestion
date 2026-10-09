import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';

const name = 'uconext-offline-update-test';
afterEach(async () => { await Dexie.delete(name); });

async function install() {
  let work: Promise<unknown> | undefined;
  const addAll = vi.fn(async () => {});
  runInNewContext(readFileSync(resolve('public/offline-delivery-worker-v1.js'),'utf8')+'\n'+readFileSync(resolve('public/sw.js'), 'utf8').replace("importScripts('/offline-delivery-worker-v1.js');",''), {
    indexedDB, TextEncoder, TextDecoder, Uint8Array, Error, Promise, URL,
    self: { addEventListener: (kind: string, handler: (event: { waitUntil: (promise: Promise<unknown>) => void }) => void) => {
      if (kind === 'install') handler({ waitUntil: (promise) => { work = promise; } });
    } },
    caches: { open: async () => ({ addAll }) },
  });
  await work;
  return addAll;
}

it('T191A blocks worker installation until the existing database is migrated', async () => {
  const db = new Dexie(name);
  db.version(2).stores({ delivery_queue: 'id' });
  await db.open();
  const envelope = new TextEncoder().encode('{"version":1,"keyId":"old-key"}');
  await db.table('delivery_queue').add({ id: 'pending', envelope });
  db.close();
  await expect(install()).rejects.toThrow('OFFLINE_UPDATE_INCOMPATIBLE');
  await db.open();
  expect(Array.from((await db.table('delivery_queue').get('pending')).envelope)).toEqual(Array.from(envelope));
  db.close();
});

it('T191A allows a migrated database with pending envelopes using historical keys', async () => {
  const db = new Dexie(name);
  db.version(4).stores({ delivery_queue: 'id' });
  await db.open();
  await db.table('delivery_queue').add({ id: 'pending', envelope: new TextEncoder().encode('{"version":1,"keyId":"old-key"}') });
  db.close();
  expect(await install()).toHaveBeenCalledOnce();
});
