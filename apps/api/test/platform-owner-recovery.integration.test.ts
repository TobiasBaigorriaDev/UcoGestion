import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { PlatformDatabase } from '../src/modules/platform-admin/platform-database.js';
import {
  OwnerRecoveryNotAllowedError,
  PlatformOwnerRecoveryService,
} from '../src/modules/platform-admin/platform-owner-recovery.service.js';

describe('exceptional OWNER recovery', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let platformDatabase: PlatformDatabase;
  let recovery: PlatformOwnerRecoveryService;
  let platformAdminUserId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    platformDatabase = new PlatformDatabase({ connectionString: container.getConnectionUri() });
    recovery = new PlatformOwnerRecoveryService(platformDatabase);
    platformAdminUserId = (await createGlobalUser(pool, {
      email: 'recovery-admin@example.com',
      password: 'platform-password',
    })).id;
    await pool.query("INSERT INTO platform_admins (user_id, status) VALUES ($1, 'ACTIVE')", [platformAdminUserId]);
  });

  afterAll(async () => {
    await platformDatabase?.close();
    await pool?.end();
    await container?.stop();
  });

  it('restores exactly one existing user as OWNER only when none remains and audits the intervention', async () => {
    const organizationId = randomUUID();
    const previousOwner = await createGlobalUser(pool, { email: 'previous-owner@example.com', password: 'owner-password' });
    const recoveredOwner = await createGlobalUser(pool, { email: 'recovered-owner@example.com', password: 'owner-password' });
    await pool.query(
      "INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'Recovery Org', 'ARS', 'America/Argentina/Mendoza')",
      [organizationId],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role, revoked_at)
       VALUES ($1, $2, $3, 'OWNER', now())`,
      [randomUUID(), organizationId, previousOwner.id],
    );

    const input = {
      confirmation: 'RECOVER_OWNER' as const,
      organizationId,
      ownerEmail: recoveredOwner.email,
      requestId: 'recover-owner-001',
    };
    const first = await recovery.execute(platformAdminUserId, input);
    expect(await recovery.execute(platformAdminUserId, input)).toEqual(first);

    expect(
      await pool.query(
        `SELECT role, revoked_at FROM memberships
         WHERE id = $1 AND organization_id = $2 AND user_id = $3`,
        [first.membershipId, organizationId, recoveredOwner.id],
      ),
    ).toMatchObject({ rows: [{ revoked_at: null, role: 'OWNER' }] });
    expect(
      await pool.query(
        `SELECT action, actor_user_id, entity_id, context_data->>'recoveredUserId' AS recovered_user_id
         FROM security_audit_events WHERE request_id = $1`,
        [input.requestId],
      ),
    ).toMatchObject({
      rows: [{
        action: 'OWNER_RECOVERED',
        actor_user_id: platformAdminUserId,
        entity_id: organizationId,
        recovered_user_id: recoveredOwner.id,
      }],
    });
  });

  it('refuses recovery while any active OWNER remains', async () => {
    const organizationId = randomUUID();
    const currentOwner = await createGlobalUser(pool, { email: 'current-owner@example.com', password: 'owner-password' });
    const candidate = await createGlobalUser(pool, { email: 'candidate-owner@example.com', password: 'owner-password' });
    await pool.query(
      "INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'Protected Org', 'ARS', 'America/Argentina/Mendoza')",
      [organizationId],
    );
    await pool.query(
      "INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [randomUUID(), organizationId, currentOwner.id],
    );

    await expect(recovery.execute(platformAdminUserId, {
      confirmation: 'RECOVER_OWNER',
      organizationId,
      ownerEmail: candidate.email,
      requestId: 'recover-owner-denied-001',
    })).rejects.toBeInstanceOf(OwnerRecoveryNotAllowedError);
    expect(await pool.query("SELECT id FROM security_audit_events WHERE request_id = 'recover-owner-denied-001'")).toMatchObject({ rows: [] });
  });
});
