import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { TenantMembershipService } from '../src/modules/auth/tenant-membership.service.js';
import {
  InvitationCreationPolicyError,
  InvitationCreationService,
} from '../src/modules/users/invitation-creation.service.js';
import {
  MembershipAdministrationError,
  MembershipAdministrationService,
} from '../src/modules/users/membership-administration.service.js';
import { UserManagementReadService } from '../src/modules/users/user-management-read.service.js';

describe('membership administration', () => {
  let adminUserId: string;
  let branchA: string;
  let cashierUserId: string;
  let container: StartedPostgreSqlContainer;
  let employeeMembershipId: string;
  let employeeUserId: string;
  let invitations: InvitationCreationService;
  let memberships: MembershipAdministrationService;
  let reader: UserManagementReadService;
  let organizationId: string;
  let ownerMembershipId: string;
  let ownerUserId: string;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const transactions = new TenantTransaction(pool);
    invitations = new InvitationCreationService(transactions);
    memberships = new MembershipAdministrationService(transactions);
    reader = new UserManagementReadService(transactions);

    organizationId = randomUUID();
    branchA = randomUUID();
    ownerUserId = randomUUID();
    adminUserId = randomUUID();
    cashierUserId = randomUUID();
    employeeUserId = randomUUID();
    ownerMembershipId = randomUUID();
    employeeMembershipId = randomUUID();
    const adminMembershipId = randomUUID();
    const cashierMembershipId = randomUUID();

    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'membership.owner@example.com', '$argon2id$v=19$owner', 1),
       ($2, 'membership.admin@example.com', '$argon2id$v=19$admin', 1),
       ($3, 'membership.cashier@example.com', '$argon2id$v=19$cashier', 1),
       ($4, 'membership.employee@example.com', '$argon2id$v=19$employee', 1)`,
      [ownerUserId, adminUserId, cashierUserId, employeeUserId],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone)
       VALUES ($1, 'Membership administration', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Principal')`,
      [branchA, organizationId],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'),
       ($4, $2, $5, 'ADMIN'),
       ($6, $2, $7, 'CASHIER'),
       ($8, $2, $9, 'EMPLOYEE')`,
      [
        ownerMembershipId, organizationId, ownerUserId,
        adminMembershipId, adminUserId,
        cashierMembershipId, cashierUserId,
        employeeMembershipId, employeeUserId,
      ],
    );
    await pool.query(
      `INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES
       ($1, $2, $4), ($1, $3, $4), ($1, $5, $4)`,
      [organizationId, adminMembershipId, cashierMembershipId, branchA, employeeMembershipId],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('returns only administrable members and assigned branches to ADMIN', async () => {
    const result = await reader.read(context(adminUserId, 'admin-read'));
    expect(result.actorRole).toBe('ADMIN');
    expect(result.branches.map((branch) => branch.id)).toEqual([branchA]);
    expect(result.memberships.map((member) => member.email)).not.toContain('membership.owner@example.com');
    expect(result.memberships.find((member) => member.id === employeeMembershipId)).toMatchObject({
      branchIds: [branchA], role: 'EMPLOYEE', version: 1,
    });
  });

  it('prevents ADMIN from changing a member assigned only outside their branch scope', async () => {
    const otherBranch = randomUUID();
    const otherUser = randomUUID();
    const otherMembership = randomUUID();
    await pool.query('INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, $3)', [otherBranch, organizationId, `Outside ${otherBranch}`]);
    await pool.query('INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, $2, $3, 1)', [otherUser, `${otherUser}@example.com`, '$argon2id$v=19$other']);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'EMPLOYEE')", [otherMembership, organizationId, otherUser]);
    await pool.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)', [organizationId, otherMembership, otherBranch]);

    const view = await reader.read(context(adminUserId, 'outside-read'));
    expect(view.memberships.some((member) => member.id === otherMembership)).toBe(false);
    await expect(memberships.changeRole(context(adminUserId, 'outside-role'), otherMembership,
      { role: 'CASHIER', branchIds: [branchA], expectedVersion: 1 })).rejects.toMatchObject({ code: 'MEMBERSHIP_BRANCH_SCOPE_FORBIDDEN' });
    await expect(memberships.setStatus(context(adminUserId, 'outside-status'), otherMembership,
      { status: 'INACTIVE', expectedVersion: 1 })).rejects.toMatchObject({ code: 'MEMBERSHIP_BRANCH_SCOPE_FORBIDDEN' });
    await expect(memberships.revoke(context(adminUserId, 'outside-revoke'), otherMembership, 1)).rejects.toMatchObject({ code: 'MEMBERSHIP_BRANCH_SCOPE_FORBIDDEN' });
  });

  it('replays a role change with the same version and key without a second write', async () => {
    const userId = randomUUID();
    const membershipId = randomUUID();
    await pool.query('INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, $2, $3, 1)', [userId, `${userId}@example.com`, '$argon2id$v=19$idempotent']);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'EMPLOYEE')", [membershipId, organizationId, userId]);
    await pool.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)', [organizationId, membershipId, branchA]);
    const change = { role: 'CASHIER' as const, branchIds: [branchA], expectedVersion: 1 };
    const first = await memberships.changeRole(context(ownerUserId, 'role-idempotent'), membershipId, change, 'role-change-key');
    expect(first).toEqual({ role: 'CASHIER', version: 2 });
    expect(await memberships.changeRole(context(ownerUserId, 'role-retry'), membershipId, change, 'role-change-key')).toEqual(first);
    const audits = await pool.query<{ count: string }>("SELECT count(*) FROM audit_events WHERE entity_id = $1 AND action = 'membership.role_changed'", [membershipId]);
    expect(audits.rows[0]?.count).toBe('1');
  });

  it('does not mistake a targeted membership for an actor without membership', async () => {
    const outsiderUserId = randomUUID();
    await pool.query('INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, $2, $3, 1)', [outsiderUserId, `${outsiderUserId}@example.com`, '$argon2id$v=19$outsider']);
    await expect(memberships.changeRole(context(outsiderUserId, 'outsider-role'), ownerMembershipId,
      { role: 'OWNER', branchIds: [], expectedVersion: 1 })).rejects.toMatchObject({ code: 'MEMBERSHIP_NOT_MUTABLE' });
  });

  it('prevents non-OWNER actors from creating, promoting, degrading or revoking OWNER', async () => {
    await expect(invitations.create(
      context(adminUserId, 'admin-invite-owner'),
      { branchIds: [], email: 'new.owner@example.com', role: 'OWNER' },
    )).rejects.toMatchObject({ code: 'INVITATION_OWNER_FORBIDDEN' } satisfies Partial<InvitationCreationPolicyError>);

    await expect(memberships.changeRole(
      context(adminUserId, 'admin-promote-owner'),
      employeeMembershipId,
      { branchIds: [], expectedVersion: 1, role: 'OWNER' },
    )).rejects.toMatchObject({ code: 'OWNER_MEMBERSHIP_FORBIDDEN' } satisfies Partial<MembershipAdministrationError>);
    await expect(memberships.changeRole(
      context(adminUserId, 'admin-degrade-owner'),
      ownerMembershipId,
      { branchIds: [branchA], expectedVersion: 1, role: 'ADMIN' },
    )).rejects.toMatchObject({ code: 'OWNER_MEMBERSHIP_FORBIDDEN' } satisfies Partial<MembershipAdministrationError>);
    await expect(memberships.revoke(
      context(adminUserId, 'admin-revoke-owner'),
      ownerMembershipId,
      1,
    )).rejects.toMatchObject({ code: 'OWNER_MEMBERSHIP_FORBIDDEN' } satisfies Partial<MembershipAdministrationError>);
    await expect(memberships.changeRole(
      context(cashierUserId, 'cashier-promote-owner'),
      employeeMembershipId,
      { branchIds: [], expectedVersion: 1, role: 'OWNER' },
    )).rejects.toMatchObject({ code: 'MEMBERSHIP_MANAGEMENT_FORBIDDEN' } satisfies Partial<MembershipAdministrationError>);

    const unchanged = await pool.query<{ id: string; role: string }>(
      'SELECT id, role FROM memberships WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[ownerMembershipId, employeeMembershipId]],
    );
    expect(unchanged.rows).toEqual([
      { id: ownerMembershipId, role: 'OWNER' },
      { id: employeeMembershipId, role: 'EMPLOYEE' },
    ].sort((left, right) => left.id.localeCompare(right.id)));
  });

  it('serializes concurrent OWNER removals and ignores pending OWNER invitations', async () => {
    const concurrentOrganizationId = randomUUID();
    const firstOwnerUserId = randomUUID();
    const secondOwnerUserId = randomUUID();
    const firstOwnerMembershipId = randomUUID();
    const secondOwnerMembershipId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, $2, '$argon2id$v=19$owner-one', 1),
       ($3, $4, '$argon2id$v=19$owner-two', 1)`,
      [
        firstOwnerUserId, `owner.one.${concurrentOrganizationId}@example.com`,
        secondOwnerUserId, `owner.two.${concurrentOrganizationId}@example.com`,
      ],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone)
       VALUES ($1, 'Concurrent owners', 'ARS', 'America/Argentina/Mendoza')`,
      [concurrentOrganizationId],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'OWNER')`,
      [
        firstOwnerMembershipId, concurrentOrganizationId, firstOwnerUserId,
        secondOwnerMembershipId, secondOwnerUserId,
      ],
    );
    await pool.query(
      `INSERT INTO invitations (
         id, organization_id, email_normalized, role, status, token_hash,
         expires_at, invited_by_membership_id
       ) VALUES ($1, $2, $3, 'OWNER', 'PENDING', $4, now() + interval '1 day', $5)`,
      [
        randomUUID(),
        concurrentOrganizationId,
        `pending.owner.${concurrentOrganizationId}@example.com`,
        'a'.repeat(64),
        firstOwnerMembershipId,
      ],
    );

    const attempts = await Promise.allSettled([
      memberships.revoke(
        { organizationId: concurrentOrganizationId, requestId: 'revoke-owner-one', userId: firstOwnerUserId },
        firstOwnerMembershipId,
        1,
      ),
      memberships.revoke(
        { organizationId: concurrentOrganizationId, requestId: 'revoke-owner-two', userId: secondOwnerUserId },
        secondOwnerMembershipId,
        1,
      ),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: 'ORGANIZATION_OWNER_REQUIRED',
    } satisfies Partial<MembershipAdministrationError>);

    const activeOwners = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM memberships
       WHERE organization_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'`,
      [concurrentOrganizationId],
    );
    expect(activeOwners.rows[0]?.count).toBe('1');
  });

  it('allows an OWNER to degrade or deactivate another OWNER only while one remains active', async () => {
    const degradable = await seedOwnerPair(pool, 'Degrade owner');
    const deactivated = await seedOwnerPair(pool, 'Deactivate owner');
    const branchId = randomUUID();
    await pool.query(
      `INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Degraded owner scope')`,
      [branchId, degradable.organizationId],
    );

    await expect(memberships.changeRole(
      {
        organizationId: degradable.organizationId,
        requestId: 'degrade-second-owner',
        userId: degradable.firstOwnerUserId,
      },
      degradable.secondOwnerMembershipId,
      { branchIds: [branchId], expectedVersion: 1, role: 'ADMIN' },
    )).resolves.toEqual({ role: 'ADMIN', version: 2 });

    await expect(memberships.setStatus(
      {
        organizationId: deactivated.organizationId,
        requestId: 'deactivate-second-owner',
        userId: deactivated.firstOwnerUserId,
      },
      deactivated.secondOwnerMembershipId,
      { expectedVersion: 1, status: 'INACTIVE' },
    )).resolves.toEqual({ status: 'INACTIVE', version: 2 });
    await expect(new TenantMembershipService(pool).isActive(
      deactivated.organizationId,
      deactivated.secondOwnerUserId,
      'inactive-owner-access',
    )).resolves.toBe(false);

    await expect(memberships.setStatus(
      {
        organizationId: degradable.organizationId,
        requestId: 'deactivate-last-owner',
        userId: degradable.firstOwnerUserId,
      },
      degradable.firstOwnerMembershipId,
      { expectedVersion: 1, status: 'INACTIVE' },
    )).rejects.toMatchObject({
      code: 'ORGANIZATION_OWNER_REQUIRED',
    } satisfies Partial<MembershipAdministrationError>);

    for (const organization of [degradable.organizationId, deactivated.organizationId]) {
      const activeOwners = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM memberships
         WHERE organization_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'`,
        [organization],
      );
      expect(activeOwners.rows[0]?.count).toBe('1');
    }
  });

  it('lets ADMIN manage only non-owner branch assignments inside its own scope', async () => {
    const branchB = randomUUID();
    const branchOutsideAdminScope = randomUUID();
    const secondEmployeeUserId = randomUUID();
    const secondEmployeeMembershipId = randomUUID();
    const adminMembership = await pool.query<{ id: string }>(
      `SELECT id FROM memberships
       WHERE organization_id = $1 AND user_id = $2 AND role = 'ADMIN'`,
      [organizationId, adminUserId],
    );
    const adminMembershipId = adminMembership.rows.at(0)?.id;
    if (!adminMembershipId) throw new Error('Expected ADMIN membership.');

    await pool.query(
      `INSERT INTO branches (id, organization_id, name) VALUES
       ($1, $3, 'Secondary'), ($2, $3, 'Outside admin scope')`,
      [branchB, branchOutsideAdminScope, organizationId],
    );
    await pool.query(
      `INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES
       ($1, $2, $3), ($1, $4, $5)`,
      [organizationId, adminMembershipId, branchB, employeeMembershipId, branchOutsideAdminScope],
    );
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
       VALUES ($1, $2, '$argon2id$v=19$employee-two', 1)`,
      [secondEmployeeUserId, `${secondEmployeeUserId}@example.com`],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role)
       VALUES ($1, $2, $3, 'EMPLOYEE')`,
      [secondEmployeeMembershipId, organizationId, secondEmployeeUserId],
    );
    await pool.query(
      `INSERT INTO membership_branches (organization_id, membership_id, branch_id)
       VALUES ($1, $2, $3)`,
      [organizationId, secondEmployeeMembershipId, branchA],
    );

    await expect(memberships.changeRole(
      context(adminUserId, 'admin-update-own-scope'),
      employeeMembershipId,
      { branchIds: [branchB], expectedVersion: 1, role: 'EMPLOYEE' },
    )).resolves.toEqual({ role: 'EMPLOYEE', version: 2 });

    const preservedScope = await pool.query<{ branch_id: string }>(
      `SELECT branch_id FROM membership_branches
       WHERE organization_id = $1 AND membership_id = $2 ORDER BY branch_id`,
      [organizationId, employeeMembershipId],
    );
    expect(preservedScope.rows.map(({ branch_id }) => branch_id)).toEqual(
      [branchB, branchOutsideAdminScope].sort(),
    );

    await expect(memberships.changeRole(
      context(adminUserId, 'admin-grant-outside-scope'),
      secondEmployeeMembershipId,
      { branchIds: [branchOutsideAdminScope], expectedVersion: 1, role: 'CASHIER' },
    )).rejects.toBeInstanceOf(Error);
    const untouched = await pool.query<{ branch_id: string; role: string }>(
      `SELECT membership_branches.branch_id, memberships.role
       FROM memberships
       JOIN membership_branches
         ON membership_branches.organization_id = memberships.organization_id
        AND membership_branches.membership_id = memberships.id
       WHERE memberships.id = $1`,
      [secondEmployeeMembershipId],
    );
    expect(untouched.rows).toEqual([{ branch_id: branchA, role: 'EMPLOYEE' }]);
  });

  it('revokes online access immediately and records when each device learned the revocation', async () => {
    const revocationOrganizationId = randomUUID();
    const revokerUserId = randomUUID();
    const revokedUserId = randomUUID();
    const revokerMembershipId = randomUUID();
    const revokedMembershipId = randomUUID();
    const deviceId = randomUUID();
    let clock = new Date('2026-10-02T12:00:00.000Z');
    const service = new MembershipAdministrationService(new TenantTransaction(pool), { now: () => clock });
    const access = new TenantMembershipService(pool);

    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, $2, '$argon2id$v=19$revoker', 1),
       ($3, $4, '$argon2id$v=19$revoked', 1)`,
      [revokerUserId, `${revokerUserId}@example.com`, revokedUserId, `${revokedUserId}@example.com`],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone)
       VALUES ($1, 'Membership revocation', 'ARS', 'America/Argentina/Mendoza')`,
      [revocationOrganizationId],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'EMPLOYEE')`,
      [revokerMembershipId, revocationOrganizationId, revokerUserId, revokedMembershipId, revokedUserId],
    );

    await expect(access.isActive(revocationOrganizationId, revokedUserId, 'access-before-revocation'))
      .resolves.toBe(true);
    await expect(service.revoke(
      {
        organizationId: revocationOrganizationId,
        requestId: 'revoke-membership',
        userId: revokerUserId,
      },
      revokedMembershipId,
      1,
    )).resolves.toEqual({ revokedAt: '2026-10-02T12:00:00.000Z', version: 2 });
    await expect(access.isActive(revocationOrganizationId, revokedUserId, 'access-after-revocation'))
      .resolves.toBe(false);

    clock = new Date('2026-10-02T13:00:00.000Z');
    await expect(service.recordDeviceRevocationKnowledge(
      {
        organizationId: revocationOrganizationId,
        requestId: 'device-knows-revocation',
        userId: revokerUserId,
      },
      revokedMembershipId,
      deviceId,
    )).resolves.toEqual({ knownAt: '2026-10-02T13:00:00.000Z' });
    clock = new Date('2026-10-02T14:00:00.000Z');
    await expect(service.recordDeviceRevocationKnowledge(
      {
        organizationId: revocationOrganizationId,
        requestId: 'device-repeats-revocation',
        userId: revokerUserId,
      },
      revokedMembershipId,
      deviceId,
    )).resolves.toEqual({ knownAt: '2026-10-02T13:00:00.000Z' });

    const stored = await pool.query<{
      device_id: string;
      known_at: Date;
      revoked_at: Date;
      status: string;
    }>(
      `SELECT knowledge.device_id, knowledge.known_at, knowledge.revoked_at, memberships.status
       FROM membership_revocation_device_knowledge AS knowledge
       JOIN memberships
         ON memberships.organization_id = knowledge.organization_id
        AND memberships.id = knowledge.membership_id
       WHERE knowledge.organization_id = $1 AND knowledge.membership_id = $2`,
      [revocationOrganizationId, revokedMembershipId],
    );
    expect(stored.rows).toEqual([{
      device_id: deviceId,
      known_at: new Date('2026-10-02T13:00:00.000Z'),
      revoked_at: new Date('2026-10-02T12:00:00.000Z'),
      status: 'REVOKED',
    }]);
  });

  function context(userId: string, requestId: string) {
    return { organizationId, requestId, userId };
  }
});

async function seedOwnerPair(pool: Pool, name: string): Promise<{
  firstOwnerMembershipId: string;
  firstOwnerUserId: string;
  organizationId: string;
  secondOwnerMembershipId: string;
  secondOwnerUserId: string;
}> {
  const organizationId = randomUUID();
  const firstOwnerUserId = randomUUID();
  const secondOwnerUserId = randomUUID();
  const firstOwnerMembershipId = randomUUID();
  const secondOwnerMembershipId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
     ($1, $2, '$argon2id$v=19$owner-one', 1),
     ($3, $4, '$argon2id$v=19$owner-two', 1)`,
    [
      firstOwnerUserId, `${firstOwnerUserId}@example.com`,
      secondOwnerUserId, `${secondOwnerUserId}@example.com`,
    ],
  );
  await pool.query(
    `INSERT INTO organizations (id, name, base_currency, timezone)
     VALUES ($1, $2, 'ARS', 'America/Argentina/Mendoza')`,
    [organizationId, name],
  );
  await pool.query(
    `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
     ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'OWNER')`,
    [
      firstOwnerMembershipId, organizationId, firstOwnerUserId,
      secondOwnerMembershipId, secondOwnerUserId,
    ],
  );
  return {
    firstOwnerMembershipId,
    firstOwnerUserId,
    organizationId,
    secondOwnerMembershipId,
    secondOwnerUserId,
  };
}
