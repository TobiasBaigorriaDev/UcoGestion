import { createHash, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import {
  ExistingAccountInvitationAcceptanceService,
  InvitationAcceptanceError,
} from '../src/modules/users/existing-account-invitation-acceptance.service.js';

describe('existing-account invitation acceptance', () => {
  let adminPool: Pool;
  let container: StartedPostgreSqlContainer;
  let runtimePool: Pool;
  let service: ExistingAccountInvitationAcceptanceService;

  const now = new Date('2026-09-22T18:00:00.000Z');

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    adminPool = new Pool({ connectionString: container.getConnectionUri() });
    await adminPool.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");

    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'uco_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    service = new ExistingAccountInvitationAcceptanceService(runtimePool, { now: () => now });
  });

  afterAll(async () => {
    await runtimePool?.end();
    await adminPool?.end();
    await container?.stop();
  });

  it('atomically consumes the token and creates one scoped membership for the existing global user', async () => {
    const fixture = await seedInvitation(adminPool, now);
    const userCountBefore = await countUsers(adminPool);

    const attempts = await Promise.allSettled([
      service.accept(fixture.token, 'accept-existing-001'),
      service.accept(fixture.token, 'accept-existing-002'),
    ]);

    const accepted = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<{ membershipId: string; organizationId: string }> =>
        attempt.status === 'fulfilled',
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
    );
    expect(
      accepted,
      rejected.map((attempt) => String(attempt.reason)).join('\n'),
    ).toHaveLength(1);
    expect(accepted[0]?.value.organizationId).toBe(fixture.organizationId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(InvitationAcceptanceError);
    expect((rejected[0]?.reason as InvitationAcceptanceError).code).toBe('INVITATION_NOT_ACCEPTABLE');

    expect(await countUsers(adminPool)).toBe(userCountBefore);
    const memberships = await adminPool.query<{
      id: string;
      organization_id: string;
      role: string;
      user_id: string;
    }>(
      `SELECT id, organization_id, user_id, role
       FROM memberships
       WHERE organization_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [fixture.organizationId, fixture.existingUserId],
    );
    expect(memberships.rows).toEqual([
      {
        id: accepted[0]?.value.membershipId,
        organization_id: fixture.organizationId,
        role: 'CASHIER',
        user_id: fixture.existingUserId,
      },
    ]);

    const assignedBranches = await adminPool.query<{ branch_id: string }>(
      `SELECT branch_id
       FROM membership_branches
       WHERE organization_id = $1 AND membership_id = $2
       ORDER BY branch_id`,
      [fixture.organizationId, accepted[0]?.value.membershipId],
    );
    expect(assignedBranches.rows.map(({ branch_id }) => branch_id)).toEqual(
      [fixture.branchOneId, fixture.branchTwoId].sort(),
    );

    const invitation = await adminPool.query<{ accepted_at: Date; status: string }>(
      'SELECT status, accepted_at FROM invitations WHERE id = $1',
      [fixture.invitationId],
    );
    expect(invitation.rows).toEqual([{ accepted_at: now, status: 'ACCEPTED' }]);

    const audit = await adminPool.query<{
      action: string;
      actor_user_id: string;
      after_data: Record<string, unknown>;
      organization_id: string;
    }>(
      `SELECT organization_id, actor_user_id, action, after_data
       FROM audit_events
       WHERE entity_type = 'invitation' AND entity_id = $1`,
      [fixture.invitationId],
    );
    expect(audit.rows).toEqual([
      {
        action: 'invitation.accepted',
        actor_user_id: fixture.existingUserId,
        after_data: {
          membershipId: accepted[0]?.value.membershipId,
          status: 'ACCEPTED',
        },
        organization_id: fixture.organizationId,
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(fixture.token);
  });
});

async function countUsers(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
  return Number(result.rows[0]?.count ?? '0');
}

async function seedInvitation(pool: Pool, acceptedAt: Date): Promise<{
  branchOneId: string;
  branchTwoId: string;
  existingUserId: string;
  invitationId: string;
  organizationId: string;
  token: string;
}> {
  const branchOneId = randomUUID();
  const branchTwoId = randomUUID();
  const existingUserId = randomUUID();
  const invitationId = randomUUID();
  const inviterMembershipId = randomUUID();
  const inviterUserId = randomUUID();
  const organizationId = randomUUID();
  const token = 'existing-account-invitation-token';
  const tokenHash = createHash('sha256').update(token).digest('hex');

  await pool.query(
    `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
     ($1, 'existing.invitee@example.com', '$argon2id$v=19$existing', 1),
     ($2, 'existing.inviter@example.com', '$argon2id$v=19$inviter', 1)`,
    [existingUserId, inviterUserId],
  );
  await pool.query(
    `INSERT INTO organizations (id, name, base_currency, timezone)
     VALUES ($1, 'Existing account invitation', 'ARS', 'America/Argentina/Mendoza')`,
    [organizationId],
  );
  await pool.query(
    `INSERT INTO branches (id, organization_id, name) VALUES
     ($1, $3, 'One'), ($2, $3, 'Two')`,
    [branchOneId, branchTwoId, organizationId],
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
     ) VALUES ($1, $2, 'existing.invitee@example.com', 'CASHIER', 'PENDING', $3, $4, $5, $6)`,
    [
      invitationId,
      organizationId,
      tokenHash,
      new Date(acceptedAt.getTime() + 24 * 60 * 60 * 1_000),
      inviterMembershipId,
      new Date(acceptedAt.getTime() - 24 * 60 * 60 * 1_000),
    ],
  );
  await pool.query(
    `INSERT INTO invitation_branches (organization_id, invitation_id, branch_id) VALUES
     ($1, $2, $3), ($1, $2, $4)`,
    [organizationId, invitationId, branchOneId, branchTwoId],
  );

  return { branchOneId, branchTwoId, existingUserId, invitationId, organizationId, token };
}
