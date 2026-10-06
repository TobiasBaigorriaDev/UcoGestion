import Dexie from 'dexie';

import { OfflineDatabase } from './offline-database';

/** Migrate all identities before offering the new worker, without unlocking data. */
export async function prepareOfflineUpdate(): Promise<void> {
  for (const name of await Dexie.getDatabaseNames()) {
    if (!name.startsWith('uconext-offline-')) continue;
    const identity = /^uconext-offline-([0-9a-f-]{36})-([0-9a-f-]{36})$/i.exec(name);
    if (!identity?.[1] || !identity[2]) throw new Error('OFFLINE_UPDATE_INCOMPATIBLE');
    const db = new OfflineDatabase(identity[1], identity[2]);
    try { await db.open(); }
    finally { db.close(); }
  }
}
