import { createHash, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { InvitationAcceptanceError } from '../src/modules/users/existing-account-invitation-acceptance.service.js';
import {
  InvitationRevocationError,
  InvitationRevocationService,
} from '../src/modules/users/invitation-revocation.service.js';
import { NewAccountInvitationAcceptanceService } from '../src/modules/users/new-account-invitation-acceptance.service.js';

describe('invitation revocation', () => {
  let acceptance: NewAccountInvitationAcceptanceService;
  let adminPool: Pool;
  let adminUserId: string;
  let branchA: string;
  let branchB: string;
  let container: StartedPostgreSqlContainer;
  let employeeUserId: string;
  let organizationA: string;
  let organizationB: string;
  let ownerAMembershipId: string;
  let ownerAUserId: string;
  let ownerBMembershipId: string;
  let revocation: InvitationRevocationService;
  let runtimePool: Pool;

  const now = new Date('2026-09-23T12:00:00.000Z');

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    adminPool = new Pool({ connectionString: container.getConnectionUri() });
    await adminPool.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");

    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'uco_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    revocation = new InvitationRevocationService(new TenantTransaction(runtimePool), { now: () => now });
    acceptance = new NewAccountInvitationAcceptanceService(runtimePool, { now: () => now });

    organizationA = randomUUID();
    organizationB = randomUUID();
    branchA = randomUUID();
    branchB = randomUUID();
    ownerAUserId = randomUUID();
    adminUserId = randomUUID();
    employeeUserId = randomUUID();
    const ownerBUserId = randomUUID();
    ownerAMembershipId = randomUUID();
    ownerBMembershipId = randomUUID();

    await adminPool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'revoke.owner.a@example.com', '$argon2id$v=19$owner-a', 1),
       ($2, 'revoke.admin@example.com', '$argon2id$v=19$admin', 1),
       ($3, 'revoke.employee@example.com', '$argon2id$v=19$employee', 1),
       ($4, 'revoke.owner.b@example.com', '$argon2id$v=19$owner-b', 1)`,
      [ownerAUserId, adminUserId, employeeUserId, ownerBUserId],
    );
    await adminPool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Revocation A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Revocation B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );
    await adminPool.query(
      `INSERT INTO branches (id, organization_id, name) VALUES
       ($1, $2, 'Branch A'), ($3, $4, 'Branch B')`,
      [branchA, organizationA, branchB, organizationB],
    );
    const adminMembershipId = randomUUID();
    await adminPool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'),
       ($4, $2, $5, 'ADMIN'),
       ($6, $2, $7, 'EMPLOYEE'),
       ($8, $9, $10, 'OWNER')`,
      [
        ownerAMembershipId,
        organizationA,
        ownerAUserId,
        adminMembershipId,
        adminUserId,
        randomUUID(),
        employeeUserId,
        ownerBMembershipId,
        organizationB,
        ownerBUserId,
      ],
    );
    await adminPool.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)', [organizationA, adminMembershipId, branchA]);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await adminPool?.end();
    await container?.stop();
  });

  it('lets OWNER revoke a pending invitation once and prevents its later acceptance', async () => {
    const invitation = await seedInvitation(
      adminPool,
      organizationA,
      branchA,
      ownerAMembershipId,
      'revoked.invitee@example.com',
      'revoked-invitation-token',
      now,
    );

    await expect(revocation.revoke(
      { organizationId: organizationA, requestId: 'revoke-001', userId: ownerAUserId },
      invitation.id,
    )).resolves.toEqual({ invitationId: invitation.id, status: 'REVOKED' });

    const stored = await adminPool.query<{ revoked_at: Date; status: string }>(
      'SELECT status, revoked_at FROM invitations WHERE id = $1',
      [invitation.id],
    );
    expect(stored.rows).toEqual([{ revoked_at: now, status: 'REVOKED' }]);
    await expect(acceptance.accept(
      { password: 'valid-new-password', token: invitation.token },
      'accept-revoked-001',
    )).rejects.toBeInstanceOf(InvitationAcceptanceError);
    const invitedUser = await adminPool.query('SELECT id FROM users WHERE email_normalized = $1', [invitation.email]);
    expect(invitedUser.rows).toEqual([]);

    await expect(revocation.revoke(
      { organizationId: organizationA, requestId: 'revoke-002', userId: ownerAUserId },
      invitation.id,
    )).rejects.toMatchObject({ code: 'INVITATION_NOT_REVOCABLE' } satisfies Partial<InvitationRevocationError>);

    const audits = await adminPool.query<{
      action: string;
      actor_user_id: string;
      after_data: Record<string, unknown>;
      before_data: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, action, before_data, after_data
       FROM audit_events WHERE entity_type = 'invitation' AND entity_id = $1`,
      [invitation.id],
    );
    expect(audits.rows).toEqual([{
      action: 'invitation.revoked',
      actor_user_id: ownerAUserId,
      after_data: { status: 'REVOKED' },
      before_data: { status: 'PENDING' },
    }]);
  });

  it('allows ADMIN but denies operational roles and cross-tenant invitation ids', async () => {
    const outsideBranch = randomUUID();
    await adminPool.query('INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, $3)', [outsideBranch, organizationA, `Outside ${outsideBranch}`]);
    const outsideInvitation = await seedInvitation(adminPool, organizationA, outsideBranch, ownerAMembershipId, 'outside-admin@example.com', 'outside-token', now);
    const adminInvitation = await seedInvitation(
      adminPool,
      organizationA,
      branchA,
      ownerAMembershipId,
      'admin-revoked@example.com',
      'admin-revoked-token',
      now,
    );
    const employeeInvitation = await seedInvitation(
      adminPool,
      organizationA,
      branchA,
      ownerAMembershipId,
      'employee-denied@example.com',
      'employee-denied-token',
      now,
    );
    const foreignInvitation = await seedInvitation(
      adminPool,
      organizationB,
      branchB,
      ownerBMembershipId,
      'foreign-invitee@example.com',
      'foreign-token',
      now,
    );

    await expect(revocation.revoke(
      { organizationId: organizationA, requestId: 'revoke-admin', userId: adminUserId },
      adminInvitation.id,
    )).resolves.toMatchObject({ status: 'REVOKED' });
    await expect(revocation.revoke(
      { organizationId: organizationA, requestId: 'revoke-outside', userId: adminUserId },
      outsideInvitation.id,
    )).rejects.toMatchObject({ code: 'INVITATION_REVOCATION_FORBIDDEN' });
    await expect(revocation.revoke(
      { organizationId: organizationA, requestId: 'revoke-employee', userId: employeeUserId },
      employeeInvitation.id,
    )).rejects.toMatchObject({ code: 'INVITATION_REVOCATION_FORBIDDEN' } satisfies Partial<InvitationRevocationError>);
    await expect(revocation.revoke(
      { organizationId: organizationA, requestId: 'revoke-cross-tenant', userId: ownerAUserId },
      foreignInvitation.id,
    )).rejects.toMatchObject({ code: 'INVITATION_NOT_REVOCABLE' } satisfies Partial<InvitationRevocationError>);

    const untouched = await adminPool.query<{ id: string; status: string }>(
      'SELECT id, status FROM invitations WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[employeeInvitation.id, foreignInvitation.id]],
    );
    expect(untouched.rows).toEqual([
      { id: employeeInvitation.id, status: 'PENDING' },
      { id: foreignInvitation.id, status: 'PENDING' },
    ].sort((left, right) => left.id.localeCompare(right.id)));
  });
});

async function seedInvitation(
  pool: Pool,
  organizationId: string,
  branchId: string,
  inviterMembershipId: string,
  email: string,
  token: string,
  revokedAt: Date,
): Promise<{ email: string; id: string; token: string }> {
  const id = randomUUID();
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO invitations (
       id, organization_id, email_normalized, role, status, token_hash,
       expires_at, invited_by_membership_id, created_at
     ) VALUES ($1, $2, $3, 'EMPLOYEE', 'PENDING', $4, $5, $6, $7)`,
    [
      id,
      organizationId,
      email,
      tokenHash,
      new Date(revokedAt.getTime() + 24 * 60 * 60 * 1_000),
      inviterMembershipId,
      new Date(revokedAt.getTime() - 24 * 60 * 60 * 1_000),
    ],
  );
  await pool.query(
    `INSERT INTO invitation_branches (organization_id, invitation_id, branch_id)
     VALUES ($1, $2, $3)`,
    [organizationId, id, branchId],
  );
  return { email, id, token };
}
