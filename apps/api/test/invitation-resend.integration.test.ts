import { createHash, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import {
  ExistingAccountInvitationAcceptanceService,
  InvitationAcceptanceError,
} from '../src/modules/users/existing-account-invitation-acceptance.service.js';
import {
  InvitationResendError,
  InvitationResendService,
} from '../src/modules/users/invitation-resend.service.js';

describe('invitation resend', () => {
  let acceptance: ExistingAccountInvitationAcceptanceService;
  let adminPool: Pool;
  let container: StartedPostgreSqlContainer;
  let employeeUserId: string;
  let organizationA: string;
  let organizationB: string;
  let ownerAUserId: string;
  let ownerBMembershipId: string;
  let ownerBUserId: string;
  let resend: InvitationResendService;
  let runtimePool: Pool;

  const now = new Date('2026-10-01T12:00:00.000Z');

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    adminPool = new Pool({ connectionString: container.getConnectionUri() });
    await adminPool.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");

    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'uco_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    resend = new InvitationResendService(new TenantTransaction(runtimePool), { now: () => now });
    acceptance = new ExistingAccountInvitationAcceptanceService(runtimePool, { now: () => now });

    organizationA = randomUUID();
    organizationB = randomUUID();
    ownerAUserId = randomUUID();
    ownerBUserId = randomUUID();
    employeeUserId = randomUUID();
    ownerBMembershipId = randomUUID();
    await adminPool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'resend.owner.a@example.com', '$argon2id$v=19$owner-a', 1),
       ($2, 'resend.owner.b@example.com', '$argon2id$v=19$owner-b', 1),
       ($3, 'resend.employee@example.com', '$argon2id$v=19$employee', 1)`,
      [ownerAUserId, ownerBUserId, employeeUserId],
    );
    await adminPool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Resend A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Resend B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );
    await adminPool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'),
       ($4, $2, $5, 'EMPLOYEE'),
       ($6, $7, $8, 'OWNER')`,
      [
        randomUUID(), organizationA, ownerAUserId,
        randomUUID(), employeeUserId,
        ownerBMembershipId, organizationB, ownerBUserId,
      ],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await adminPool?.end();
    await container?.stop();
  });

  it('reissues an expired invitation with a new token and creates only one membership', async () => {
    const fixture = await seedInvitation(adminPool, {
      invitedByMembershipId: await ownerMembershipId(adminPool, organizationA),
      organizationId: organizationA,
      status: 'EXPIRED',
      token: 'expired-token-before-resend',
    });

    await expect(resend.resend(
      { organizationId: organizationA, requestId: 'resend-001', userId: ownerAUserId },
      fixture.invitationId,
    )).resolves.toEqual({
      expiresAt: '2026-10-08T12:00:00.000Z',
      invitationId: fixture.invitationId,
    });

    const stored = await adminPool.query<{ expires_at: Date; status: string; token_hash: string }>(
      'SELECT status, token_hash, expires_at FROM invitations WHERE id = $1',
      [fixture.invitationId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ expires_at: new Date('2026-10-08T12:00:00.000Z'), status: 'PENDING' });
    expect(stored.rows[0]?.token_hash).not.toBe(createHash('sha256').update(fixture.token).digest('hex'));

    const outbox = await adminPool.query<{ payload: { invitationId: string; token: string } }>(
      `SELECT payload FROM outbox_jobs
       WHERE organization_id = $1 AND job_type = 'INVITATION_EMAIL'
       ORDER BY created_at DESC`,
      [organizationA],
    );
    expect(outbox.rows).toHaveLength(1);
    const resentToken = outbox.rows[0]?.payload.token;
    expect(resentToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(outbox.rows[0]?.payload.invitationId).toBe(fixture.invitationId);
    expect(createHash('sha256').update(resentToken ?? '').digest('hex')).toBe(stored.rows[0]?.token_hash);

    const expirationJob = await adminPool.query<{
      available_at: Date;
      payload: { expiresAt: string; invitationId: string };
    }>(
      `SELECT available_at, payload FROM outbox_jobs
       WHERE organization_id = $1 AND job_type = 'INVITATION_EXPIRATION'`,
      [organizationA],
    );
    expect(expirationJob.rows).toEqual([{
      available_at: new Date('2026-10-08T12:00:00.000Z'),
      payload: {
        expiresAt: '2026-10-08T12:00:00.000Z',
        invitationId: fixture.invitationId,
      },
    }]);

    await expect(acceptance.accept(fixture.token, 'accept-old-token'))
      .rejects.toBeInstanceOf(InvitationAcceptanceError);
    const accepted = await acceptance.accept(resentToken ?? '', 'accept-resent-token');
    await expect(acceptance.accept(resentToken ?? '', 'accept-resent-token-again'))
      .rejects.toBeInstanceOf(InvitationAcceptanceError);

    const memberships = await adminPool.query<{ id: string }>(
      `SELECT id FROM memberships
       WHERE organization_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [organizationA, fixture.invitedUserId],
    );
    expect(memberships.rows).toEqual([{ id: accepted.membershipId }]);
    await expect(resend.resend(
      { organizationId: organizationA, requestId: 'resend-accepted', userId: ownerAUserId },
      fixture.invitationId,
    )).rejects.toMatchObject({ code: 'INVITATION_NOT_RESENDABLE' } satisfies Partial<InvitationResendError>);

    const audits = await adminPool.query<{ action: string; after_data: Record<string, unknown> }>(
      `SELECT action, after_data FROM audit_events
       WHERE entity_type = 'invitation' AND entity_id = $1 AND action = 'invitation.resent'`,
      [fixture.invitationId],
    );
    expect(audits.rows).toEqual([{ action: 'invitation.resent', after_data: { status: 'PENDING' } }]);
    expect(JSON.stringify(audits.rows)).not.toContain(resentToken);
  });

  it('denies operational roles and cross-tenant invitation identifiers', async () => {
    const ownerAMembershipId = await ownerMembershipId(adminPool, organizationA);
    const local = await seedInvitation(adminPool, {
      invitedByMembershipId: ownerAMembershipId,
      organizationId: organizationA,
      status: 'PENDING',
      token: 'employee-denied-resend-token',
    });
    const foreign = await seedInvitation(adminPool, {
      invitedByMembershipId: ownerBMembershipId,
      organizationId: organizationB,
      status: 'PENDING',
      token: 'cross-tenant-resend-token',
    });

    await expect(resend.resend(
      { organizationId: organizationA, requestId: 'resend-employee', userId: employeeUserId },
      local.invitationId,
    )).rejects.toMatchObject({ code: 'INVITATION_RESEND_FORBIDDEN' } satisfies Partial<InvitationResendError>);
    await expect(resend.resend(
      { organizationId: organizationA, requestId: 'resend-cross-tenant', userId: ownerAUserId },
      foreign.invitationId,
    )).rejects.toMatchObject({ code: 'INVITATION_NOT_RESENDABLE' } satisfies Partial<InvitationResendError>);

    const unchanged = await adminPool.query<{ id: string; token_hash: string }>(
      'SELECT id, token_hash FROM invitations WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[local.invitationId, foreign.invitationId]],
    );
    expect(unchanged.rows).toEqual([
      { id: local.invitationId, token_hash: createHash('sha256').update(local.token).digest('hex') },
      { id: foreign.invitationId, token_hash: createHash('sha256').update(foreign.token).digest('hex') },
    ].sort((left, right) => left.id.localeCompare(right.id)));
  });

  it('keeps the previous token valid when queuing the resend email fails', async () => {
    const fixture = await seedInvitation(adminPool, {
      invitedByMembershipId: await ownerMembershipId(adminPool, organizationA),
      organizationId: organizationA,
      status: 'PENDING',
      token: 'token-preserved-after-outbox-failure',
    });
    const before = await adminPool.query<{ expires_at: Date; token_hash: string }>(
      'SELECT token_hash, expires_at FROM invitations WHERE id = $1',
      [fixture.invitationId],
    );
    await adminPool.query(`
      CREATE FUNCTION reject_resend_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.job_type = 'INVITATION_EMAIL' THEN
          RAISE EXCEPTION 'simulated resend outbox failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_resend_outbox_insert
      BEFORE INSERT ON outbox_jobs
      FOR EACH ROW EXECUTE FUNCTION reject_resend_outbox_insert();
    `);

    try {
      await expect(resend.resend(
        { organizationId: organizationA, requestId: 'resend-rollback', userId: ownerAUserId },
        fixture.invitationId,
      )).rejects.toThrow('simulated resend outbox failure');
    } finally {
      await adminPool.query('DROP TRIGGER reject_resend_outbox_insert ON outbox_jobs');
      await adminPool.query('DROP FUNCTION reject_resend_outbox_insert()');
    }

    const after = await adminPool.query<{ expires_at: Date; token_hash: string }>(
      'SELECT token_hash, expires_at FROM invitations WHERE id = $1',
      [fixture.invitationId],
    );
    expect(after.rows).toEqual(before.rows);
    expect(await adminPool.query(
      "SELECT id FROM audit_events WHERE request_id = 'resend-rollback'",
    )).toMatchObject({ rows: [] });
  });
});

async function ownerMembershipId(pool: Pool, organizationId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM memberships WHERE organization_id = $1 AND role = 'OWNER'",
    [organizationId],
  );
  const id = result.rows.at(0)?.id;
  if (!id) throw new Error('Expected OWNER membership.');
  return id;
}

async function seedInvitation(
  pool: Pool,
  input: {
    invitedByMembershipId: string;
    organizationId: string;
    status: 'EXPIRED' | 'PENDING';
    token: string;
  },
): Promise<{ invitationId: string; invitedUserId: string; token: string }> {
  const invitationId = randomUUID();
  const invitedUserId = randomUUID();
  const email = `resend.invitee.${invitationId}@example.com`;
  await pool.query(
    `INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
     VALUES ($1, $2, '$argon2id$v=19$invitee', 1)`,
    [invitedUserId, email],
  );
  await pool.query(
    `INSERT INTO invitations (
       id, organization_id, email_normalized, role, status, token_hash,
       expires_at, invited_by_membership_id, created_at
     ) VALUES ($1, $2, $3, 'ADMIN', $4, $5, $6, $7, $8)`,
    [
      invitationId,
      input.organizationId,
      email,
      input.status,
      createHash('sha256').update(input.token).digest('hex'),
      input.status === 'EXPIRED' ? new Date(nowForFixture() - 1_000) : new Date(nowForFixture() + 86_400_000),
      input.invitedByMembershipId,
      new Date(nowForFixture() - 7 * 86_400_000),
    ],
  );
  return { invitationId, invitedUserId, token: input.token };
}

function nowForFixture(): number {
  return new Date('2026-10-01T12:00:00.000Z').getTime();
}
