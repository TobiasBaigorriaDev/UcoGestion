import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { OfflineDatabase } from '../src/offline/offline-database';
import { readOpaqueProgress } from '../src/offline/opaque-progress';
const org = '11111111-1111-4111-8111-111111111111', device = '22222222-2222-4222-8222-222222222222';
afterEach(() => Dexie.delete(OfflineDatabase.nameFor(org, device)));
it('T220B returns only generic transport counts across identities without reading private records', async () => {
  const db = new OfflineDatabase(org, device);
  await db.enqueueOpaque('private-operation', new TextEncoder().encode('opaque-private-tenant'));
  await db.putEncrypted('private-actor', 'operation', 'private-operation', new Uint8Array([99]));
  await db.delivery_receipts.add({ id: 'rejected-id', status: 'SECURITY_REJECTED', envelopeHash: 'a'.repeat(64) });
  const progress = await readOpaqueProgress();
  expect(progress).toEqual({ pending: 1, rejected: 1 });
  expect(JSON.stringify(progress)).not.toMatch(/private|rejected-id|11111111/);
  expect(await db.records.count()).toBe(1);
  db.close();
});
