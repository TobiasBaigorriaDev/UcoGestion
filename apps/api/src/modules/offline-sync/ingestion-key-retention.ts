import { createPublicKey } from 'node:crypto';

import type { PoolClient } from 'pg';

import { OfflineKeysUnavailableError } from './offline-key-custody.js';
import type { IngestionKeyBackup } from './sync-envelope-decryptor.js';

/** Registry is global public key material, never tenant data or private custody. */
export async function preserveIngestionKeys(client: PoolClient, inventory: IngestionKeyBackup): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('uco:ingestion-key-inventory'))");
  const publicKeys = new Map(Object.entries(inventory.keys).map(([id, pem]) => [id,
    createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString()]));
  const historical = await client.query<{ key_id: string; public_key_pem: string }>(
    'SELECT key_id, public_key_pem FROM offline_ingestion_key_registry');
  for (const row of historical.rows) {
    if (publicKeys.get(row.key_id) !== row.public_key_pem) {
      throw new OfflineKeysUnavailableError('Historical ingestion key unavailable.');
    }
  }
  for (const [id, pem] of publicKeys) {
    await client.query(`INSERT INTO offline_ingestion_key_registry (key_id, public_key_pem)
      VALUES ($1, $2) ON CONFLICT (key_id) DO NOTHING`, [id, pem]);
  }
}
