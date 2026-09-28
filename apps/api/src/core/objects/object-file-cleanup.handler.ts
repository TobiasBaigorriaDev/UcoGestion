import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { OutboxJob } from '../outbox/outbox-worker.js';
import type { ObjectStoragePort } from './object-storage.port.js';

export async function handleObjectFileCleanup(job: OutboxJob, client: PoolClient,
  storage: ObjectStoragePort): Promise<void> {
  if (job.jobType !== 'OBJECT_FILE_CLEANUP') throw new Error('Invalid cleanup job type.');
  const { fileId } = z.strictObject({ fileId: z.uuid() }).parse(job.payload);
  const result = await client.query<{ storage_key: string; expired: boolean }>(
    `SELECT storage_key,expires_at <= now() AS expired FROM object_files
      WHERE organization_id = $1 AND id = $2`, [job.organizationId, fileId]);
  const file = result.rows[0];
  if (!file) return;
  if (!file.expired) throw new Error('Object file has not expired yet.');
  await storage.delete(file.storage_key);
  await client.query(`UPDATE report_exports SET status = 'EXPIRED', updated_at = now()
    WHERE organization_id = $1 AND file_id = $2 AND status = 'READY'`,
  [job.organizationId, fileId]);
}
