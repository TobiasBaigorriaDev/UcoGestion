import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { readOperationalSnapshot } from '../src/core/observability/operational-monitor.js';

it('T230 counts durable failures under RLS and rejects cross-tenant monitoring', async () => {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin = new Pool({ connectionString: container.getConnectionUri() });
  let runtime: Pool | undefined;
  try {
    await runMigrations(container.getConnectionUri());
    await admin.query("CREATE ROLE monitor_runtime LOGIN PASSWORD 'test' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri()); url.username = 'monitor_runtime'; url.password = 'test';
    runtime = new Pool({ connectionString: url.toString() });
    const user = randomUUID(), org = randomUUID(), foreign = randomUUID();
    await admin.query("INSERT INTO users(id,email_normalized,password_hash,password_hash_version) VALUES($1,'monitor@example.com','$argon2id$v=19$test',1)", [user]);
    await admin.query("INSERT INTO organizations(id,name,base_currency,timezone) VALUES($1,'Monitor','ARS','UTC'),($2,'Foreign','ARS','UTC')", [org, foreign]);
    await admin.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'OWNER')", [randomUUID(),org,user]);
    for (const tenant of [org,foreign]) await admin.query(`INSERT INTO outbox_jobs(id,organization_id,job_key,job_type,payload,actor_user_id,authorization_class,status)
      VALUES($1,$2,'failed','REPORT_PDF','{}',$3,'OWNER','DEAD_LETTER')`, [randomUUID(),tenant,user]);
    const transactions = new TenantTransaction(runtime);
    expect(await readOperationalSnapshot(transactions,{organizationId:org,userId:user,requestId:randomUUID()}))
      .toEqual({deadLetters:1,conflicts:0,syncPendingAgeSeconds:0});
    await expect(readOperationalSnapshot(transactions,{organizationId:foreign,userId:user,requestId:randomUUID()})).rejects.toThrow(/OWNER/);
    expect((await admin.query('SELECT count(*)::int AS count FROM outbox_jobs')).rows[0]?.count).toBe(2);
  } finally { await runtime?.end(); await admin.end(); await container.stop(); }
});
