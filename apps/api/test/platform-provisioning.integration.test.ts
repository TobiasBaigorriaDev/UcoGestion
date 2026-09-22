import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { PlatformDatabase } from '../src/modules/platform-admin/platform-database.js';
import { PlatformProvisioningService } from '../src/modules/platform-admin/platform-provisioning.service.js';

describe('assisted platform provisioning', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let platformDatabase: PlatformDatabase;
  let platformAdminUserId: string;
  let provisioning: PlatformProvisioningService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    platformDatabase = new PlatformDatabase({ connectionString: container.getConnectionUri() });
    platformAdminUserId = (await createGlobalUser(pool, {
      email: 'platform@example.com',
      password: 'platform-password',
    })).id;
    await pool.query("INSERT INTO platform_admins (user_id, status) VALUES ($1, 'ACTIVE')", [platformAdminUserId]);
    provisioning = new PlatformProvisioningService(platformDatabase);
  });

  afterAll(async () => {
    await platformDatabase?.close();
    await pool?.end();
    await container?.stop();
  });

  it('creates the ARS organization, first branch, OWNER and audit atomically and replays idempotently', async () => {
    const command = {
      firstBranchName: ' Casa Central ',
      organizationName: ' Comercial Andina ',
      ownerEmail: ' OWNER@ANDINA.EXAMPLE ',
      ownerPassword: 'a-secure-owner-password',
      requestId: 'provision-andina-001',
      timezone: 'America/Argentina/Mendoza',
    };
    const first = await provisioning.execute(platformAdminUserId, command);
    const replay = await provisioning.execute(platformAdminUserId, command);

    expect(replay).toEqual(first);
    const organization = await pool.query<{
      base_currency: string;
      country_code: string;
      name: string;
      timezone: string;
    }>('SELECT name, country_code, base_currency, timezone FROM organizations WHERE id = $1', [first.organizationId]);
    expect(organization.rows[0]).toEqual({
      base_currency: 'ARS',
      country_code: 'AR',
      name: 'Comercial Andina',
      timezone: 'America/Argentina/Mendoza',
    });
    expect(await pool.query('SELECT id, name FROM branches WHERE id = $1', [first.branchId])).toMatchObject({
      rows: [{ id: first.branchId, name: 'Casa Central' }],
    });
    expect(
      await pool.query(
        `SELECT memberships.role, memberships.revoked_at, users.email_normalized
         FROM memberships JOIN users ON users.id = memberships.user_id
         WHERE memberships.id = $1`,
        [first.membershipId],
      ),
    ).toMatchObject({ rows: [{ email_normalized: 'owner@andina.example', revoked_at: null, role: 'OWNER' }] });
    expect(
      await pool.query(
        `SELECT action, actor_user_id, entity_id FROM security_audit_events
         WHERE request_id = $1`,
        [command.requestId],
      ),
    ).toMatchObject({
      rows: [{ action: 'ORGANIZATION_PROVISIONED', actor_user_id: platformAdminUserId, entity_id: first.organizationId }],
    });
  });

  it('rolls back every row when creation of the first branch fails', async () => {
    await pool.query(`
      CREATE FUNCTION reject_provisioning_branch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'Rollback Branch' THEN RAISE EXCEPTION 'simulated branch failure'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_provisioning_branch BEFORE INSERT ON branches
      FOR EACH ROW EXECUTE FUNCTION reject_provisioning_branch();
    `);

    await expect(
      provisioning.execute(platformAdminUserId, {
        firstBranchName: 'Rollback Branch',
        organizationName: 'Rollback Organization',
        ownerEmail: 'rollback-owner@example.com',
        ownerPassword: 'a-secure-owner-password',
        requestId: 'provision-rollback-001',
        timezone: 'America/Argentina/Buenos_Aires',
      }),
    ).rejects.toThrow('simulated branch failure');

    expect(await pool.query("SELECT id FROM organizations WHERE name = 'Rollback Organization'")).toMatchObject({ rows: [] });
    expect(await pool.query("SELECT id FROM users WHERE email_normalized = 'rollback-owner@example.com'")).toMatchObject({ rows: [] });
    expect(await pool.query("SELECT id FROM security_audit_events WHERE request_id = 'provision-rollback-001'")).toMatchObject({ rows: [] });
    expect(await pool.query("SELECT request_id FROM platform_operations WHERE request_id = 'provision-rollback-001'")).toMatchObject({ rows: [] });

    await pool.query('DROP TRIGGER reject_provisioning_branch ON branches');
    await pool.query('DROP FUNCTION reject_provisioning_branch()');
  });
});
