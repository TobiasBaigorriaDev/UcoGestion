import { OfflineDatabase } from './offline-database';
import { OfflineKeys } from './offline-keys';

/** Retire access while preserving original identity ciphertext and PIN wrapping. */
export async function retireOfflineIdentity(db: OfflineDatabase): Promise<void> {
  OfflineKeys.lockAll(db.name);
  await db.transaction('rw', [db.key_envelopes, db.device_keys], async () => {
    const device = await db.device_keys.get('device');
    if (!device) return;
    const users = await db.key_envelopes.toCollection().primaryKeys();
    await db.device_keys.put({ ...device, retiredUsers: [...new Set([...(device.retiredUsers ?? []), ...users])] });
  });
}

/** Called only after an authenticated online response establishes the active actor. */
export async function activateOfflineIdentity(db: OfflineDatabase, userId: string, reauthenticated = false): Promise<void> {
  await db.transaction('rw', [db.device_keys, db.pin_attempts], async () => {
    const device = await db.device_keys.get('device');
    if (!device || device.revoked || device.revokedUsers?.includes(userId)) throw new Error('OFFLINE_REVOKED');
    await db.device_keys.put({ ...device, retiredUsers: (device.retiredUsers ?? []).filter(id => id !== userId) });
    if (reauthenticated) await db.pin_attempts.delete(userId);
  });
}

export async function retireAllOfflineIdentities(): Promise<void> {
  OfflineKeys.lockAll();
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('uco:identity-retired', crypto.randomUUID());
    window.dispatchEvent(new Event('uco:identity-retired'));
  }
  if (typeof indexedDB === 'undefined') return;
  for (const name of await OfflineDatabase.getDatabaseNames()) {
    const match = /^uconext-offline-([0-9a-f-]{36})-([0-9a-f-]{36})$/i.exec(name);
    if (!match?.[1] || !match[2]) continue;
    const db = new OfflineDatabase(match[1], match[2]);
    try { await db.open(); await retireOfflineIdentity(db); } finally { db.close(); }
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('uco:delivery-request'));
}

export function observeIdentityRetirement(target: Window = window): () => void {
  const lock = () => OfflineKeys.lockAll();
  const storage = (event: StorageEvent) => { if (event.key === 'uco:identity-retired') lock(); };
  target.addEventListener('storage', storage);
  target.addEventListener('uco:identity-retired', lock);
  return () => { target.removeEventListener('storage', storage); target.removeEventListener('uco:identity-retired', lock); };
}
