import { createHash, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { InvitationCreationService } from '../src/modules/users/invitation-creation.service.js';
import { NonOwnerMembershipPolicyError } from '../src/modules/users/non-owner-membership.policy.js';

describe('invitation creation', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let service: InvitationCreationService;
  let organizationA: string;
  let organizationB: string;
  let ownerUserId: string;
  let adminUserId: string;
  let branchA1: string;
  let branchA2: string;
  let branchB: string;

  const now = new Date('2026-09-22T15:00:00.000Z');

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    service = new InvitationCreationService(new TenantTransaction(pool), { now: () => now });

    organizationA = randomUUID();
    organizationB = randomUUID();
    ownerUserId = randomUUID();
    adminUserId = randomUUID();
    branchA1 = randomUUID();
    branchA2 = randomUUID();
    branchB = randomUUID();
    const ownerMembershipId = randomUUID();
    const adminMembershipId = randomUUID();

    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'invite-owner@example.com', '$argon2id$v=19$test', 1),
       ($2, 'invite-admin@example.com', '$argon2id$v=19$test', 1)`,
      [ownerUserId, adminUserId],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Invitation A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Invitation B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );
    await pool.query(
      `INSERT INTO branches (id, organization_id, name) VALUES
       ($1, $2, 'A one'), ($3, $2, 'A two'), ($4, $5, 'B one')`,
      [branchA1, organizationA, branchA2, branchB, organizationB],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'ADMIN')`,
      [ownerMembershipId, organizationA, ownerUserId, adminMembershipId, adminUserId],
    );
    await pool.query(
      'INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationA, adminMembershipId, branchA1],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('stores only the token hash and atomically queues the role and branches for email', async () => {
    const result = await service.create(
      { organizationId: organizationA, requestId: 'invite-owner-001', userId: ownerUserId },
      {
        branchIds: [branchA2, branchA1],
        email: ' New.Member@Example.com ',
        role: 'CASHIER',
      },
    );

    expect(result.expiresAt).toBe('2026-09-29T15:00:00.000Z');
    const invitation = await pool.query<{
      created_at: Date;
      email_normalized: string;
      expires_at: Date;
      role: string;
      status: string;
      token_hash: string;
    }>(
      `SELECT email_normalized, role, status, token_hash, expires_at, created_at
       FROM invitations WHERE id = $1`,
      [result.invitationId],
    );
    expect(invitation.rows).toHaveLength(1);
    const row = invitation.rows[0];
    if (!row) throw new Error('Expected the invitation row.');
    expect(row).toMatchObject({
      email_normalized: 'new.member@example.com',
      role: 'CASHIER',
      status: 'PENDING',
    });
    expect(row.created_at).toEqual(now);
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const assignedBranches = await pool.query<{ branch_id: string }>(
      'SELECT branch_id FROM invitation_branches WHERE organization_id = $1 AND invitation_id = $2 ORDER BY branch_id',
      [organizationA, result.invitationId],
    );
    expect(assignedBranches.rows.map(({ branch_id }) => branch_id)).toEqual([branchA1, branchA2].sort());

    const outbox = await pool.query<{
      payload: { branchIds: string[]; email: string; role: string; token: string };
      status: string;
    }>(
      "SELECT payload, status FROM outbox_jobs WHERE job_type = 'INVITATION_EMAIL' AND job_key = $1",
      [`invitation-email:${result.invitationId}`],
    );
    expect(outbox.rows).toHaveLength(1);
    const job = outbox.rows[0];
    if (!job) throw new Error('Expected the invitation email job.');
    expect(job).toMatchObject({
      payload: {
        branchIds: [branchA1, branchA2].sort(),
        email: 'new.member@example.com',
        role: 'CASHIER',
      },
      status: 'PENDING',
    });
    expect(job.payload.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHash('sha256').update(job.payload.token).digest('hex')).toBe(row.token_hash);
    expect(JSON.stringify(invitation.rows)).not.toContain(job.payload.token);

    const audit = await pool.query<{ after_data: Record<string, unknown>; context_data: Record<string, unknown> }>(
      "SELECT after_data, context_data FROM audit_events WHERE entity_id = $1 AND action = 'invitation.created'",
      [result.invitationId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain(job.payload.token);
    expect(JSON.stringify(audit.rows)).not.toContain(row.token_hash);
  });

  it('limits ADMIN to assigned branches and rejects cross-tenant branch identifiers', async () => {
    await expect(service.create(
      { organizationId: organizationA, requestId: 'invite-admin-allowed', userId: adminUserId },
      { branchIds: [branchA1], email: 'allowed@example.com', role: 'EMPLOYEE' },
    )).resolves.toMatchObject({ invitationId: expect.any(String) });

    await expect(service.create(
      { organizationId: organizationA, requestId: 'invite-admin-outside', userId: adminUserId },
      { branchIds: [branchA2], email: 'outside@example.com', role: 'EMPLOYEE' },
    )).rejects.toBeInstanceOf(NonOwnerMembershipPolicyError);
    await expect(service.create(
      { organizationId: organizationA, requestId: 'invite-admin-cross-tenant', userId: adminUserId },
      { branchIds: [branchB], email: 'cross-tenant@example.com', role: 'EMPLOYEE' },
    )).rejects.toBeInstanceOf(NonOwnerMembershipPolicyError);

    const rejected = await pool.query<{ count: string }>(
      "SELECT count(*) FROM invitations WHERE email_normalized IN ('outside@example.com', 'cross-tenant@example.com')",
    );
    expect(rejected.rows[0]?.count).toBe('0');
  });

  it('rolls back invitation, branches and audit when the email outbox insert fails', async () => {
    await pool.query(`
      CREATE FUNCTION reject_invitation_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.job_type = 'INVITATION_EMAIL' THEN
          RAISE EXCEPTION 'simulated invitation outbox failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_invitation_outbox_insert
      BEFORE INSERT ON outbox_jobs
      FOR EACH ROW EXECUTE FUNCTION reject_invitation_outbox_insert();
    `);

    await expect(service.create(
      { organizationId: organizationA, requestId: 'invite-rollback', userId: ownerUserId },
      { branchIds: [branchA1], email: 'rollback@example.com', role: 'ADMIN' },
    )).rejects.toThrow('simulated invitation outbox failure');

    const invitation = await pool.query<{ count: string }>(
      "SELECT count(*) FROM invitations WHERE email_normalized = 'rollback@example.com'",
    );
    expect(invitation.rows[0]?.count).toBe('0');
    expect(await pool.query(
      "SELECT id FROM audit_events WHERE request_id = 'invite-rollback'",
    )).toMatchObject({ rows: [] });

    await pool.query('DROP TRIGGER reject_invitation_outbox_insert ON outbox_jobs');
    await pool.query('DROP FUNCTION reject_invitation_outbox_insert()');
  });
});
