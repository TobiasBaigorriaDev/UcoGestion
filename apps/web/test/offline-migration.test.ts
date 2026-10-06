import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';

import { OfflineDatabase } from '../src/offline/offline-database.js';

const org = '11111111-1111-4111-8111-111111111111';
const device = '22222222-2222-4222-8222-222222222222';
const name = OfflineDatabase.nameFor(org, device);
const stores = { records: '[userId+kind+id]', delivery_queue: 'id', meta: 'key',
  key_envelopes: 'userId', pin_attempts: 'userId', device_keys: 'id' };

afterEach(async () => { await Dexie.delete(name); });

async function seed(version: number) {
  const legacy = new Dexie(name);
  legacy.version(2).stores(stores);
  await legacy.open();
  const ciphertext = new Uint8Array(35).fill(255);
  ciphertext[0] = 1;
  const envelope = new TextEncoder().encode(JSON.stringify({ version, keyId: 'historical-key', ciphertext: 'opaque' }));
  await legacy.table('records').add({ userId: 'alice', kind: 'sale', id: 'pending', ciphertext });
  await legacy.table('delivery_queue').add({ id: 'pending', envelope });
  await legacy.table('meta').add({ key: 'device-chain', sequence: '7', headHash: 'original' });
  legacy.close();
  return { ciphertext, envelope };
}

it('T191A migrates forward preserving records, envelopes, historical key IDs and chain', async () => {
  const original = await seed(1);
  const db = new OfflineDatabase(org, device);
  try {
    await db.open();
    expect(db.verno).toBe(3);
    expect(Array.from((await db.getEncrypted('alice', 'sale', 'pending')) ?? [])).toEqual(Array.from(original.ciphertext));
    expect(Array.from((await db.deliveryBytes())[0]?.envelope ?? [])).toEqual(Array.from(original.envelope));
    expect((await db.meta.get('device-chain'))?.sequence).toBe('7');
  } finally { db.close(); }
});

it('T191A rejects an incompatible migration atomically without deleting pending bytes', async () => {
  const original = await seed(99);
  const db = new OfflineDatabase(org, device);
  try { await expect(db.open().then(() => 'opened')).rejects.toThrow('OFFLINE_UPDATE_INCOMPATIBLE'); }
  finally { db.close(); }
  const legacy = new Dexie(name);
  legacy.version(2).stores(stores);
  try {
    await legacy.open();
    expect(legacy.verno).toBe(2);
    expect(Array.from((await legacy.table('delivery_queue').get('pending')).envelope)).toEqual(Array.from(original.envelope));
    expect(Array.from((await legacy.table('records').get(['alice', 'sale', 'pending'])).ciphertext)).toEqual(Array.from(original.ciphertext));
  } finally { legacy.close(); }
});
