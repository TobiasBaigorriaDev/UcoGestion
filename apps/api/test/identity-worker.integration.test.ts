import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { createTenantWorker } from '../src/runtime-worker.js';
import { IdentityEmailWorker } from '../src/core/outbox/identity-email-worker.js';
import type { EmailMessage } from '../src/core/email/email-port.js';
import { InvitationCreationService } from '../src/modules/users/invitation-creation.service.js';

describe('runtime identity jobs', () => {
  let container: StartedPostgreSqlContainer;
  let admin: Pool;
  let runtime: Pool;
  let dispatch: Pool;
  const userId = randomUUID();
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const sent = new Map<string, EmailMessage>();
  const email = { send: async (message: EmailMessage) => { sent.set(message.jobKey, message); } };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    admin = new Pool({ connectionString: container.getConnectionUri() });
    // A restore of a pre-106 backup provisions roles before applying missing migrations.
    await admin.query('CREATE ROLE uco_identity_dispatcher NOLOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS');
    await runMigrations(container.getConnectionUri());
    await admin.query("CREATE ROLE identity_runtime LOGIN PASSWORD 'test' IN ROLE uco_app");
    await admin.query("CREATE ROLE identity_worker LOGIN PASSWORD 'test' IN ROLE uco_worker");
    const url = new URL(container.getConnectionUri());
    url.password = 'test'; url.username = 'identity_runtime';
    runtime = new Pool({ connectionString: url.toString() });
    url.username = 'identity_worker';
    dispatch = new Pool({ connectionString: url.toString() });
    await admin.query(`INSERT INTO users(id,email_normalized,password_hash,password_hash_version)
      VALUES ($1,'worker@example.com','$argon2id$v=19$worker',1)`, [userId]);
    await admin.query(`INSERT INTO organizations(id,base_currency,timezone)
      VALUES ($1,'ARS','UTC'),($2,'ARS','UTC')`, [organizationId, otherOrganizationId]);
    await admin.query(`INSERT INTO memberships(id,organization_id,user_id,role)
      VALUES ($1,$2,$3,'OWNER')`, [randomUUID(), organizationId, userId]);
  });
  afterAll(async () => {
    await runtime?.end(); await dispatch?.end(); await admin?.end(); await container?.stop();
  });

  it('consumes invitation mail and scheduled expiration through the production worker registry', async () => {
    const transactions = new TenantTransaction(runtime);
    const result = await new InvitationCreationService(transactions).create(
      { organizationId, userId, requestId: randomUUID() },
      { email: 'invited@example.com', role: 'OWNER', branchIds: [] });
    const worker = createTenantWorker({ transactions, dispatchPool: dispatch, workerUserId: userId,
      email, report: async () => { throw new Error('Unexpected report'); },
      cleanup: async () => { throw new Error('Unexpected cleanup'); } });
    expect(await worker.processAvailable(10, 60)).toMatchObject([{ status: 'COMPLETED' }]);
    const message = sent.get(`${organizationId}:invitation-email:${result.invitationId}`);
    expect(message).toMatchObject({ email: 'invited@example.com', template: 'INVITATION', role: 'OWNER', branchIds: [] });
    expect(message?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await worker.processAvailable(10, 60)).toEqual([]);
    const expiresAt = new Date('2020-01-08T00:00:00Z').toISOString();
    await admin.query(`UPDATE invitations SET created_at='2020-01-01',expires_at=$2 WHERE id=$1`, [result.invitationId, expiresAt]);
    await admin.query(`UPDATE outbox_jobs SET available_at=$2::text::timestamptz,payload=jsonb_set(payload,'{expiresAt}',to_jsonb($2::text))
      WHERE job_type='INVITATION_EXPIRATION' AND payload->>'invitationId'=$1`, [result.invitationId, expiresAt]);
    expect(await worker.processAvailable(10, 60)).toMatchObject([{ status: 'COMPLETED' }]);
    expect((await admin.query('SELECT status FROM invitations WHERE id=$1', [result.invitationId])).rows)
      .toEqual([{ status: 'EXPIRED' }]);
    expect((await admin.query("SELECT action FROM audit_events WHERE entity_id=$1 AND action='invitation.expired'", [result.invitationId])).rows)
      .toEqual([{ action: 'invitation.expired' }]);
    expect(await transactions.read({ organizationId: otherOrganizationId, userId, requestId: randomUUID() },
      async client => (await client.query('SELECT id FROM invitations WHERE id=$1', [result.invitationId])).rows)).toEqual([]);
  });

  it('leases global reset jobs, retries with the same delivery key and dead-letters without logging tokens', async () => {
    const id = randomUUID();
    const key = `password-reset:${randomUUID()}`;
    await admin.query(`INSERT INTO identity_outbox_jobs(id,job_key,job_type,payload)
      VALUES ($1,$2,'PASSWORD_RESET_EMAIL',$3)`, [id, key, { email: 'reset@example.com', token: 'secret-reset-token' }]);
    const attempts: string[] = [];
    let fail = true;
    const worker = new IdentityEmailWorker(dispatch, { send: async message => {
      attempts.push(message.jobKey);
      if (fail) throw new Error('secret-reset-token provider failure');
      await email.send(message);
    } });
    expect(await worker.processAvailable(10, 60)).toMatchObject([{ jobId: id, status: 'RETRY_SCHEDULED' }]);
    expect(await worker.processAvailable(10, 60)).toEqual([]);
    expect((await admin.query('SELECT last_error_code,attempt_count FROM identity_outbox_jobs WHERE id=$1', [id])).rows)
      .toEqual([{ last_error_code: 'HANDLER_FAILED', attempt_count: 1 }]);
    fail = false;
    await admin.query("UPDATE identity_outbox_jobs SET available_at=now()-interval '1 second' WHERE id=$1", [id]);
    const results = await Promise.all([worker.processAvailable(10, 60), worker.processAvailable(10, 60)]);
    expect(results.flat()).toEqual([{ jobId: id, status: 'COMPLETED' }]);
    expect(attempts).toEqual([key, key]);
    expect(sent.get(key)).toMatchObject({ template: 'PASSWORD_RESET', token: 'secret-reset-token' });
    expect((await admin.query('SELECT status,payload FROM identity_outbox_jobs WHERE id=$1', [id])).rows)
      .toEqual([{ status: 'COMPLETED', payload: {} }]);
    await expect(runtime.query('SELECT * FROM claim_identity_email_jobs(10,60)')).rejects.toThrow();
    await expect(dispatch.query('SELECT * FROM identity_outbox_jobs')).rejects.toThrow();
    const badId = randomUUID();
    await admin.query(`INSERT INTO identity_outbox_jobs(id,job_key,job_type,payload,attempt_count)
      VALUES ($1,$2,'PASSWORD_RESET_EMAIL','{}',4)`, [badId, `bad:${badId}`]);
    expect(await worker.processAvailable(10, 60)).toEqual([{ jobId: badId, status: 'DEAD_LETTER' }]);
  });

  it('reclaims an expired identity lease and refuses an ACK from its former owner', async () => {
    const id = randomUUID(), key = `password-reset:${randomUUID()}`;
    await admin.query(`INSERT INTO identity_outbox_jobs(id,job_key,job_type,payload)
      VALUES ($1,$2,'PASSWORD_RESET_EMAIL',$3)`, [id, key, { email: 'lease@example.com', token: 'lease-token' }]);
    const first = (await dispatch.query<{ lease_id: string }>('SELECT * FROM claim_identity_email_jobs(1,60)')).rows[0];
    if (!first) throw new Error('Missing identity lease');
    expect(await new IdentityEmailWorker(dispatch, email).processAvailable(10, 60)).toEqual([]);
    await admin.query("UPDATE identity_outbox_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    expect(await new IdentityEmailWorker(dispatch, email).processAvailable(10, 60)).toEqual([{ jobId: id, status: 'COMPLETED' }]);
    expect((await dispatch.query('SELECT finish_identity_email_job($1,$2,true) AS status', [id, first.lease_id])).rows)
      .toEqual([{ status: null }]);
    expect(sent.get(key)).toMatchObject({ token: 'lease-token' });
  });
});

