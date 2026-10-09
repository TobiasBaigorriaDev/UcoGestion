import { OfflineDatabase } from './offline-database';
export interface OpaqueProgressState { readonly pending: number; readonly rejected: number }

/** This projection has no actor, organization, resource, operation ID or payload. */
export async function readOpaqueProgress(): Promise<OpaqueProgressState> {
  if (typeof indexedDB === 'undefined') return { pending: 0, rejected: 0 };
  let pending = 0, rejected = 0;
  for (const name of await OfflineDatabase.getDatabaseNames()) {
    const match = /^uconext-offline-([0-9a-f-]{36})-([0-9a-f-]{36})$/i.exec(name);
    if (!match?.[1] || !match[2]) continue;
    const db = new OfflineDatabase(match[1], match[2]);
    try {
      await db.open();
      pending += await db.delivery_queue.count();
      rejected += await db.delivery_receipts.filter(row => row.status === 'SECURITY_REJECTED').count();
    } finally { db.close(); }
  }
  return { pending, rejected };
}
