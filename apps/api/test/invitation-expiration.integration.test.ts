import { createHash, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { handleInvitationExpiration } from '../src/modules/users/invitation-expiration.handler.js';
import {
  ExistingAccountInvitationAcceptanceService,
  InvitationAcceptanceError,
} from '../src/modules/users/existing-account-invitation-acceptance.service.js';
import { NewAccountInvitationAcceptanceService } from '../src/modules/users/new-account-invitation-acceptance.service.js';

describe('invitation expiration', () => {
  let adminPool: Pool;
  let container: StartedPostgreSqlContainer;
  let existingAccountAcceptance: ExistingAccountInvitationAcceptanceService;
  let newAccountAcceptance: NewAccountInvitationAcceptanceService;
  let runtimePool: Pool;

  const now = new Date('2026-09-30T12:00:00.000Z');

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    adminPool = new Pool({ connectionString: container.getConnectionUri() });
    await adminPool.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");

    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'uco_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    existingAccountAcceptance = new ExistingAccountInvitationAcceptanceService(runtimePool, { now: () => now });
    newAccountAcceptance = new NewAccountInvitationAcceptanceService(runtimePool, { now: () => now });
  });

  afterAll(async () => {
    await runtimePool?.end();
    await adminPool?.end();
    await container?.stop();
  });

  it('marks a seven-day-old existing-account invitation expired and rejects its token', async () => {
    const fixture = await seedExpiredInvitation(adminPool, now, true);

    await expect(existingAccountAcceptance.accept(fixture.token, 'expire-existing'))
      .rejects.toBeInstanceOf(InvitationAcceptanceError);

    await expectInvitationExpiredWithoutMembership(adminPool, fixture);
  });

  it('marks a seven-day-old new-account invitation expired and rejects its token', async () => {
    const fixture = await seedExpiredInvitation(adminPool, now, false);

    await expect(newAccountAcceptance.accept(
      { password: 'valid-new-password', token: fixture.token },
      'expire-new',
    )).rejects.toBeInstanceOf(InvitationAcceptanceError);

    await expectInvitationExpiredWithoutMembership(adminPool, fixture);
    const invitedUser = await adminPool.query('SELECT id FROM users WHERE email_normalized = $1', [fixture.email]);
    expect(invitedUser.rows).toEqual([]);
  });

  it('marks a due invitation expired through its scheduled handler without a token attempt', async () => {
    const scheduledAt = new Date('2020-01-08T12:00:00.000Z');
    const fixture = await seedExpiredInvitation(adminPool, scheduledAt, false);
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [fixture.organizationId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [fixture.inviterUserId]);
      await client.query("SELECT set_config('app.request_id', $1, true)", ['expire-scheduled']);
      await handleInvitationExpiration({
        actorUserId: fixture.inviterUserId,
        attemptCount: 1,
        authorizationClass: 'MEMBERSHIP_ADMINISTRATION',
        branchId: null,
        id: randomUUID(),
        jobKey: `invitation-expiration:${fixture.invitationId}`,
        jobType: 'INVITATION_EXPIRATION',
        organizationId: fixture.organizationId,
        payload: { expiresAt: scheduledAt.toISOString(), invitationId: fixture.invitationId },
      }, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await expectInvitationExpiredWithoutMembership(adminPool, fixture);
    const audits = await adminPool.query<{ action: string; after_data: Record<string, unknown> }>(
      `SELECT action, after_data FROM audit_events
       WHERE entity_type = 'invitation' AND entity_id = $1`,
      [fixture.invitationId],
    );
    expect(audits.rows).toEqual([{ action: 'invitation.expired', after_data: { status: 'EXPIRED' } }]);
  });
});

interface ExpiredInvitationFixture {
  readonly email: string;
  readonly invitationId: string;
  readonly inviterUserId: string;
  readonly organizationId: string;
  readonly token: string;
}

async function expectInvitationExpiredWithoutMembership(
  pool: Pool,
  fixture: ExpiredInvitationFixture,
): Promise<void> {
  const invitation = await pool.query<{ status: string }>(
    'SELECT status FROM invitations WHERE id = $1',
    [fixture.invitationId],
  );
  expect(invitation.rows).toEqual([{ status: 'EXPIRED' }]);

  const expirationAudits = await pool.query<{
    action: string;
    actor_user_id: string;
    after_data: Record<string, unknown>;
  }>(
    `SELECT action, actor_user_id, after_data FROM audit_events
     WHERE entity_type = 'invitation' AND entity_id = $1 AND action = 'invitation.expired'`,
    [fixture.invitationId],
  );
  expect(expirationAudits.rows).toEqual([{
    action: 'invitation.expired',
    actor_user_id: fixture.inviterUserId,
    after_data: { status: 'EXPIRED' },
  }]);
  expect(JSON.stringify(expirationAudits.rows)).not.toContain(fixture.token);

  const memberships = await pool.query(
    `SELECT memberships.id
     FROM memberships
     JOIN users ON users.id = memberships.user_id
     WHERE memberships.organization_id = $1 AND users.email_normalized = $2`,
    [fixture.organizationId, fixture.email],
  );
  expect(memberships.rows).toEqual([]);
}

async function seedExpiredInvitation(
  pool: Pool,
  expiredAt: Date,
  createExistingAccount: boolean,
): Promise<ExpiredInvitationFixture> {
  const invitationId = randomUUID();
  const inviterMembershipId = randomUUID();
  const inviterUserId = randomUUID();
  const invitedUserId = randomUUID();
  const organizationId = randomUUID();
  const email = `expired.${invitationId}@example.com`;
  const token = `expired-token-${invitationId}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const createdAt = new Date(expiredAt.getTime() - 7 * 24 * 60 * 60 * 1_000);

  await pool.query(
    `INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
     VALUES ($1, $2, '$argon2id$v=19$inviter', 1)`,
    [inviterUserId, `inviter.${invitationId}@example.com`],
  );
  if (createExistingAccount) {
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
       VALUES ($1, $2, '$argon2id$v=19$invitee', 1)`,
      [invitedUserId, email],
    );
  }
  await pool.query(
    `INSERT INTO organizations (id, name, base_currency, timezone)
     VALUES ($1, 'Expired invitation', 'ARS', 'America/Argentina/Mendoza')`,
    [organizationId],
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
    [invitationId, organizationId, email, tokenHash, expiredAt, inviterMembershipId, createdAt],
  );

  return { email, invitationId, inviterUserId, organizationId, token };
}
