import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { TemporaryObjectService } from '../src/core/objects/temporary-object.service.js';
import { handleObjectFileCleanup } from '../src/core/objects/object-file-cleanup.handler.js';
import type { ObjectStoragePort } from '../src/core/objects/object-storage.port.js';

describe('temporary object files', () => {
  let container: StartedPostgreSqlContainer;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let service: TemporaryObjectService;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const actorId = randomUUID();
  const otherActorId = randomUUID();
  const uploaded = new Map<string, Uint8Array>();
  const signed: number[] = [];
  let putCalls = 0;
  let clock = new Date();
  const storage: ObjectStoragePort = {
    put: async (key, body) => { putCalls += 1; uploaded.set(key, body); },
    signedGetUrl: async (_key, _name, _contentType, seconds) => {
      signed.push(seconds);
      return `https://objects.example.test/download?expires=${seconds}`;
    },
    delete: async (key) => { uploaded.delete(key); },
  };

  const context = (userId = actorId, tenantId = organizationId) => ({
    userId, organizationId: tenantId, requestId: randomUUID(),
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    ownerPool = new Pool({ connectionString: container.getConnectionUri() });
    await ownerPool.query("CREATE ROLE objects_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'objects_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    await ownerPool.query(`INSERT INTO organizations (id,name,base_currency,timezone)
      VALUES ($1,'Objects','ARS','UTC'),($2,'Other','ARS','UTC')`,
    [organizationId, otherOrganizationId]);
    await ownerPool.query(`INSERT INTO users (id,email_normalized,password_hash,password_hash_version)
      VALUES ($1,'objects@example.com','$argon2id$v=19$owner',1),
        ($2,'objects-other@example.com','$argon2id$v=19$other',1)`,
    [actorId, otherActorId]);
    await ownerPool.query(`INSERT INTO memberships (id,organization_id,user_id,role)
      VALUES ($1,$2,$3,'OWNER')`, [randomUUID(), organizationId, actorId]);
    service = new TemporaryObjectService(new TenantTransaction(runtimePool), storage, () => clock);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    await container?.stop();
  });

  it('stores an expiring file and signs a short URL only for its actor and tenant', async () => {
    const file = await service.create(context(), { body: new Uint8Array([1, 2, 3]),
      fileName: 'sales.pdf', contentType: 'application/pdf' });
    expect(uploaded.get(file.storageKey)).toEqual(new Uint8Array([1, 2, 3]));
    expect((await ownerPool.query(`SELECT job_type,available_at FROM outbox_jobs
      WHERE job_key = $1`, [`object-file-cleanup:${file.id}`])).rows[0]?.job_type)
      .toBe('OBJECT_FILE_CLEANUP');
    expect(new Date(file.expiresAt).getTime() - clock.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(await service.signedUrl(context(), file.id)).toContain('expires=300');
    expect(signed).toEqual([300]);
    const crossTenantClient = await runtimePool.connect();
    try {
      await crossTenantClient.query('BEGIN READ ONLY');
      await crossTenantClient.query("SELECT set_config('app.organization_id',$1,true)",
        [otherOrganizationId]);
      expect((await crossTenantClient.query('SELECT id FROM object_files WHERE id = $1',
        [file.id])).rows).toEqual([]);
      await crossTenantClient.query('COMMIT');
    } finally { crossTenantClient.release(); }
    await expect(service.signedUrl(context(otherActorId), file.id)).rejects.toThrow();
    await expect(service.signedUrl(context(actorId, otherOrganizationId), file.id)).rejects.toThrow();
    clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
    await expect(service.signedUrl(context(), file.id)).rejects.toThrow();
  });

  it('rejects a non-member before uploading any bytes', async () => {
    const before = putCalls;
    await expect(service.create(context(otherActorId), { body: new Uint8Array([1]),
      fileName: 'unauthorized.pdf', contentType: 'application/pdf' })).rejects.toThrow();
    expect(putCalls).toBe(before);
  });

  it('deletes an expired object through the scheduled outbox job', async () => {
    const id = randomUUID();
    const key = `exports/${organizationId}/${id}`;
    uploaded.set(key, new Uint8Array([4]));
    await ownerPool.query(`INSERT INTO object_files (id,organization_id,actor_user_id,
      storage_key,file_name,content_type,size_bytes,created_at,expires_at)
      VALUES ($1,$2,$3,$4,'old.pdf','application/pdf',1,
        now() - interval '25 hours',now() - interval '1 hour')`,
    [id, organizationId, actorId, key]);
    await ownerPool.query(`UPDATE memberships SET status = 'REVOKED', revoked_at = now()
      WHERE organization_id = $1 AND user_id = $2`, [organizationId, actorId]);
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
      await handleObjectFileCleanup({ id: randomUUID(), organizationId,
        actorUserId: actorId, jobKey: `object-file-cleanup:${id}`,
        jobType: 'OBJECT_FILE_CLEANUP', payload: { fileId: id },
        attemptCount: 1, authorizationClass: 'OBJECT_FILE_CLEANUP', branchId: null },
      client, storage);
      await client.query('COMMIT');
    } finally { client.release(); }
    expect(uploaded.has(key)).toBe(false);
  });
});
