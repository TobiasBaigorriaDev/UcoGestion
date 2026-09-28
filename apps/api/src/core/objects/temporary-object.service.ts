import { randomUUID } from 'node:crypto';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import type { ObjectStoragePort } from './object-storage.port.js';

type ObjectContentType = 'application/pdf' | 'text/csv';

export interface TemporaryObjectInput {
  readonly body: Uint8Array;
  readonly contentType: ObjectContentType;
  readonly fileName: string;
}

export interface TemporaryObject {
  readonly id: string;
  readonly storageKey: string;
  readonly expiresAt: string;
}

export class TemporaryObjectExpiredError extends Error {
  constructor() { super('Temporary file has expired.'); }
}

export class TemporaryObjectService {
  constructor(private readonly transactions: TenantTransaction,
    private readonly storage: ObjectStoragePort,
    private readonly now: () => Date = () => new Date()) {}

  async create(context: TenantTransactionContext, input: TemporaryObjectInput): Promise<TemporaryObject> {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(input.fileName) ||
      !['application/pdf', 'text/csv'].includes(input.contentType) ||
      input.body.byteLength === 0) throw new Error('Invalid temporary file.');
    await this.transactions.read(context, async (client) => this.requireMembership(client, context));
    const id = randomUUID();
    const key = `exports/${context.organizationId}/${id}`;
    const created = this.now();
    const expiresAt = new Date(created.getTime() + 24 * 60 * 60 * 1000);
    await this.storage.put(key, input.body, input.contentType);
    try {
      await this.transactions.run(context, { action: 'object_file.created',
        entityType: 'object_file', entityId: id, branchId: null,
        before: {}, beforeAllowlist: [], context: {}, contextAllowlist: [],
        after: { expiresAt: expiresAt.toISOString() }, afterAllowlist: ['expiresAt'],
        operationId: id }, async (client) => {
        await this.requireMembership(client, context);
        await client.query(`INSERT INTO object_files (id,organization_id,actor_user_id,
          storage_key,file_name,content_type,size_bytes,created_at,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, context.organizationId, context.userId, key, input.fileName,
          input.contentType, input.body.byteLength, created, expiresAt]);
        await client.query(`INSERT INTO outbox_jobs (id,organization_id,job_key,job_type,
          payload,actor_user_id,authorization_class,available_at)
          VALUES ($1,$2,$3,'OBJECT_FILE_CLEANUP',$4::jsonb,$5,'OBJECT_FILE_CLEANUP',$6)`,
        [randomUUID(), context.organizationId, `object-file-cleanup:${id}`,
          JSON.stringify({ fileId: id }), context.userId, expiresAt]);
      });
    } catch (error) {
      try { await this.storage.delete(key); } catch { /* orphan cleanup can retry by key */ }
      throw error;
    }
    return { id, storageKey: key, expiresAt: expiresAt.toISOString() };
  }

  async signedUrl(context: TenantTransactionContext, id: string): Promise<string> {
    const file = await this.transactions.read(context, async (client) => {
      await this.requireMembership(client, context);
      const rows = await client.query<{ storage_key: string; file_name: string;
        content_type: string; expires_at: Date }>(`SELECT storage_key,file_name,content_type,expires_at
        FROM object_files WHERE organization_id = $1 AND id = $2 AND actor_user_id = $3`,
      [context.organizationId, id, context.userId]);
      return rows.rows[0];
    });
    if (!file) throw new Error('Temporary file is unavailable.');
    const remaining = Math.floor((file.expires_at.getTime() - this.now().getTime()) / 1000);
    if (remaining < 1) throw new TemporaryObjectExpiredError();
    return this.storage.signedGetUrl(file.storage_key, file.file_name, file.content_type,
      Math.min(remaining, 300));
  }

  private async requireMembership(client: import('pg').PoolClient,
    context: TenantTransactionContext): Promise<void> {
    const result = await client.query(`SELECT 1 FROM memberships
      WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE' AND revoked_at IS NULL`,
    [context.organizationId, context.userId]);
    if (result.rowCount !== 1) throw new Error('Temporary file access is forbidden.');
  }
}
