import { createHash, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { verifyPassword } from '../src/modules/auth/password.js';
import {
  NewAccountInvitationAcceptanceService,
  PasswordPolicyError,
} from '../src/modules/users/new-account-invitation-acceptance.service.js';

describe('new-account invitation acceptance', () => {
  let adminPool: Pool;
  let container: StartedPostgreSqlContainer;
  let runtimePool: Pool;
  let service: NewAccountInvitationAcceptanceService;

  const now = new Date('2026-09-22T20:00:00.000Z');

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    adminPool = new Pool({ connectionString: container.getConnectionUri() });
    await adminPool.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");

    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'uco_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    service = new NewAccountInvitationAcceptanceService(runtimePool, { now: () => now });
  });

  afterAll(async () => {
    await runtimePool?.end();
    await adminPool?.end();
    await container?.stop();
  });

  it('creates the global account with Argon2id and accepts its scoped membership atomically', async () => {
    const fixture = await seedInvitation(adminPool, now, 'new.invitee@example.com', 'new-account-token');
    const password = 'new-account-password';

    const accepted = await service.accept({ password, token: fixture.token }, 'accept-new-001');

    const user = await adminPool.query<{
      email_normalized: string;
      id: string;
      password_hash: string;
      password_hash_version: number;
    }>(
      `SELECT id, email_normalized, password_hash, password_hash_version
       FROM users WHERE email_normalized = $1`,
      [fixture.email],
    );
    expect(user.rows).toHaveLength(1);
    const userRow = user.rows[0];
    if (!userRow) throw new Error('Expected the invited account.');
    expect(userRow.id).toBe(accepted.userId);
    expect(userRow.password_hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(userRow.password_hash).not.toContain(password);
    expect(await verifyPassword(password, {
      hash: userRow.password_hash,
      version: userRow.password_hash_version,
    })).toBe(true);

    const membership = await adminPool.query<{ id: string; role: string; user_id: string }>(
      `SELECT id, role, user_id
       FROM memberships
       WHERE organization_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [fixture.organizationId, accepted.userId],
    );
    expect(membership.rows).toEqual([
      { id: accepted.membershipId, role: 'EMPLOYEE', user_id: accepted.userId },
    ]);
    const branches = await adminPool.query<{ branch_id: string }>(
      `SELECT branch_id FROM membership_branches
       WHERE organization_id = $1 AND membership_id = $2`,
      [fixture.organizationId, accepted.membershipId],
    );
    expect(branches.rows).toEqual([{ branch_id: fixture.branchId }]);
    const invitation = await adminPool.query<{ accepted_at: Date; status: string }>(
      'SELECT status, accepted_at FROM invitations WHERE id = $1',
      [fixture.invitationId],
    );
    expect(invitation.rows).toEqual([{ accepted_at: now, status: 'ACCEPTED' }]);

    const audit = await adminPool.query<{
      action: string;
      actor_user_id: string;
      after_data: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, action, after_data
       FROM audit_events WHERE entity_type = 'invitation' AND entity_id = $1`,
      [fixture.invitationId],
    );
    expect(audit.rows).toEqual([
      {
        action: 'invitation.accepted',
        actor_user_id: accepted.userId,
        after_data: { membershipId: accepted.membershipId, status: 'ACCEPTED' },
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(password);
    expect(JSON.stringify(audit.rows)).not.toContain(fixture.token);
  });

  it('requires a password of at least twelve characters before creating any account', async () => {
    const fixture = await seedInvitation(adminPool, now, 'weak.invitee@example.com', 'weak-password-token');

    await expect(service.accept({ password: 'too-short', token: fixture.token }, 'accept-new-002'))
      .rejects.toMatchObject({ code: 'PASSWORD_NOT_SECURE' } satisfies Partial<PasswordPolicyError>);

    const user = await adminPool.query('SELECT id FROM users WHERE email_normalized = $1', [fixture.email]);
    const invitation = await adminPool.query<{ status: string }>(
      'SELECT status FROM invitations WHERE id = $1',
      [fixture.invitationId],
    );
    expect(user.rows).toEqual([]);
    expect(invitation.rows).toEqual([{ status: 'PENDING' }]);
  });

  it('rolls back the new global user when assigning its invited branch fails', async () => {
    const fixture = await seedInvitation(adminPool, now, 'rollback.invitee@example.com', 'rollback-token');
    await adminPool.query(
      `CREATE FUNCTION reject_test_membership_branch() RETURNS trigger
       LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced branch failure'; END; $$`,
    );
    await adminPool.query(
      `CREATE TRIGGER reject_test_membership_branch
       BEFORE INSERT ON membership_branches
       FOR EACH ROW EXECUTE FUNCTION reject_test_membership_branch()`,
    );

    try {
      await expect(
        service.accept(
          { password: 'rollback-password', token: fixture.token },
          'accept-new-003',
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await adminPool.query('DROP TRIGGER reject_test_membership_branch ON membership_branches');
      await adminPool.query('DROP FUNCTION reject_test_membership_branch()');
    }

    const user = await adminPool.query('SELECT id FROM users WHERE email_normalized = $1', [fixture.email]);
    const invitation = await adminPool.query<{ status: string }>(
      'SELECT status FROM invitations WHERE id = $1',
      [fixture.invitationId],
    );
    const audits = await adminPool.query(
      `SELECT id FROM audit_events WHERE entity_type = 'invitation' AND entity_id = $1`,
      [fixture.invitationId],
    );
    expect(user.rows).toEqual([]);
    expect(invitation.rows).toEqual([{ status: 'PENDING' }]);
    expect(audits.rows).toEqual([]);
  });
});

async function seedInvitation(
  pool: Pool,
  acceptedAt: Date,
  email: string,
  token: string,
): Promise<{
  branchId: string;
  email: string;
  invitationId: string;
  organizationId: string;
  token: string;
}> {
  const branchId = randomUUID();
  const invitationId = randomUUID();
  const inviterMembershipId = randomUUID();
  const inviterUserId = randomUUID();
  const organizationId = randomUUID();
  const tokenHash = createHash('sha256').update(token).digest('hex');

  await pool.query(
    `INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
     VALUES ($1, $2, '$argon2id$v=19$inviter', 1)`,
    [inviterUserId, `inviter.${invitationId}@example.com`],
  );
  await pool.query(
    `INSERT INTO organizations (id, name, base_currency, timezone)
     VALUES ($1, 'New account invitation', 'ARS', 'America/Argentina/Mendoza')`,
    [organizationId],
  );
  await pool.query(
    'INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, $3)',
    [branchId, organizationId, `Branch ${branchId}`],
  );
  await pool.query(
    `INSERT INTO memberships (id, organization_id, user_id, role)
     VALUES ($1, $2, $3, 'OWNER')`,
    [inviterMembershipId, organizationId, inviterUserId],
  );
  await pool.query(
    `INSERT INTO invitations (
       id, organization_id, email_normalized, role, status, token_hash,
       expires_at, invited_by_membership_id, created_at
     ) VALUES ($1, $2, $3, 'EMPLOYEE', 'PENDING', $4, $5, $6, $7)`,
    [
      invitationId,
      organizationId,
      email,
      tokenHash,
      new Date(acceptedAt.getTime() + 24 * 60 * 60 * 1_000),
      inviterMembershipId,
      new Date(acceptedAt.getTime() - 24 * 60 * 60 * 1_000),
    ],
  );
  await pool.query(
    `INSERT INTO invitation_branches (organization_id, invitation_id, branch_id)
     VALUES ($1, $2, $3)`,
    [organizationId, invitationId, branchId],
  );

  return { branchId, email, invitationId, organizationId, token };
}
