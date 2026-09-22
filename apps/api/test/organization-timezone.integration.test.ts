import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import {
  OrganizationTimezonePermissionError,
  OrganizationTimezoneService,
  OrganizationTimezoneVersionError,
  organizationTimezoneUpdateSchema,
} from '../src/modules/organizations/organization-timezone.service.js';

describe('organization timezone', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let service: OrganizationTimezoneService;
  let organizationId: string;
  let ownerUserId: string;
  let adminUserId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    service = new OrganizationTimezoneService(new TenantTransaction(pool));
    organizationId = randomUUID();
    ownerUserId = (await createGlobalUser(pool, { email: 'timezone-owner@example.com', password: 'user-password' })).id;
    adminUserId = (await createGlobalUser(pool, { email: 'timezone-admin@example.com', password: 'user-password' })).id;
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone, created_at) VALUES
       ($1, 'Timezone Org', 'ARS', 'America/Argentina/Mendoza', '2024-01-15T12:30:45.000Z')`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'ADMIN')`,
      [randomUUID(), organizationId, ownerUserId, randomUUID(), adminUserId],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('lets OWNER change to a valid IANA timezone without rewriting absolute historical timestamps', async () => {
    const before = await pool.query<{ created_at: Date }>('SELECT created_at FROM organizations WHERE id = $1', [organizationId]);

    await expect(service.update(
      { organizationId, requestId: 'timezone-owner-001', userId: ownerUserId },
      1,
      { timezone: 'America/Argentina/Buenos_Aires' },
    )).resolves.toEqual({ timezone: 'America/Argentina/Buenos_Aires', version: 2 });

    const after = await pool.query<{ created_at: Date }>('SELECT created_at FROM organizations WHERE id = $1', [organizationId]);
    expect(after.rows[0]?.created_at.toISOString()).toBe(before.rows[0]?.created_at.toISOString());
    expect(() => organizationTimezoneUpdateSchema.parse({ timezone: 'Mars/Olympus_Mons' })).toThrow();
  });

  it('rejects ADMIN and stale OWNER updates', async () => {
    await expect(service.update(
      { organizationId, requestId: 'timezone-admin-001', userId: adminUserId },
      2,
      { timezone: 'UTC' },
    )).rejects.toBeInstanceOf(OrganizationTimezonePermissionError);

    await expect(service.update(
      { organizationId, requestId: 'timezone-stale-001', userId: ownerUserId },
      1,
      { timezone: 'UTC' },
    )).rejects.toBeInstanceOf(OrganizationTimezoneVersionError);
  });
});
