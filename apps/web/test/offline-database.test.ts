import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { OfflineDatabase } from '../src/offline/offline-database.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const alice = '33333333-3333-4333-8333-333333333333';
const bob = '44444444-4444-4444-8444-444444444444';

describe('T188 offline database', () => {
  afterEach(async () => { await Dexie.delete(OfflineDatabase.nameFor(organizationId, deviceId)); });

  it('isolates encrypted records by identity and exposes only opaque delivery bytes', async () => {
    const db = new OfflineDatabase(organizationId, deviceId);
    await db.open();
    await db.putEncrypted(alice, 'catalog', 'item-1', new Uint8Array([1, 2, 3]));
    expect(Array.from((await db.getEncrypted(alice, 'catalog', 'item-1')) ?? [])).toEqual([1, 2, 3]);
    expect(await db.getEncrypted(bob, 'catalog', 'item-1')).toBeUndefined();
    await db.enqueueOpaque('operation-1', new Uint8Array([9, 8, 7]));
    expect((await db.deliveryBytes()).map((row) => ({ id: row.id, envelope: Array.from(row.envelope) })))
      .toEqual([{ id: 'operation-1', envelope: [9, 8, 7] }]);
    db.close();
  });

  it('migrates a previous version without changing pending envelope bytes', async () => {
    const legacy = new Dexie(OfflineDatabase.nameFor(organizationId, deviceId));
    legacy.version(1).stores({ records: '[userId+kind+id]', delivery_queue: 'id', meta: 'key' });
    await legacy.open();
    const envelope = new TextEncoder().encode(JSON.stringify({ version: 1, keyId: 'historical', ciphertext: 'opaque' }));
    await legacy.table('delivery_queue').put({ id: 'pending', envelope });
    legacy.close();
    const db = new OfflineDatabase(organizationId, deviceId);
    await db.open();
    expect((await db.deliveryBytes()).map((row) => ({ id: row.id, envelope: Array.from(row.envelope) })))
      .toEqual([{ id: 'pending', envelope: Array.from(envelope) }]);
    db.close();
  });
});
