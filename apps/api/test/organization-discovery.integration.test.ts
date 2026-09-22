import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import {
  GlobalMembershipDiscoveryService,
  OrganizationNotAvailableError,
} from '../src/modules/organizations/global-membership-discovery.service.js';

describe('global membership discovery', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let discovery: GlobalMembershipDiscoveryService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    discovery = new GlobalMembershipDiscoveryService(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('lists and selects only active memberships of the authenticated user', async () => {
    const user = await createGlobalUser(pool, { email: 'multi@example.com', password: 'user-password' });
    const other = await createGlobalUser(pool, { email: 'other@example.com', password: 'user-password' });
    const activeOrganizationId = randomUUID();
    const revokedOrganizationId = randomUUID();
    const inactiveOrganizationId = randomUUID();
    const foreignOrganizationId = randomUUID();
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone, status) VALUES
       ($1, 'Active Org', 'ARS', 'America/Argentina/Mendoza', 'ACTIVE'),
       ($2, 'Revoked Org', 'ARS', 'America/Argentina/Mendoza', 'ACTIVE'),
       ($3, 'Inactive Org', 'ARS', 'America/Argentina/Mendoza', 'INACTIVE'),
       ($4, 'Foreign Org', 'ARS', 'America/Argentina/Mendoza', 'ACTIVE')`,
      [activeOrganizationId, revokedOrganizationId, inactiveOrganizationId, foreignOrganizationId],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role, revoked_at) VALUES
       ($1, $2, $3, 'ADMIN', NULL),
       ($4, $5, $3, 'OWNER', now()),
       ($6, $7, $3, 'OWNER', NULL),
       ($8, $9, $10, 'OWNER', NULL)`,
      [
        randomUUID(), activeOrganizationId, user.id,
        randomUUID(), revokedOrganizationId,
        randomUUID(), inactiveOrganizationId,
        randomUUID(), foreignOrganizationId, other.id,
      ],
    );

    await expect(discovery.list(user.id)).resolves.toEqual([
      { organizationId: activeOrganizationId, organizationName: 'Active Org', role: 'ADMIN' },
    ]);
    await expect(discovery.select(user.id, activeOrganizationId)).resolves.toEqual({
      organizationId: activeOrganizationId,
      organizationName: 'Active Org',
      role: 'ADMIN',
    });

    const deniedIds = [revokedOrganizationId, inactiveOrganizationId, foreignOrganizationId, randomUUID()];
    const failures = await Promise.all(
      deniedIds.map((organizationId) =>
        discovery.select(user.id, organizationId).catch((error: unknown) => error),
      ),
    );
    expect(failures.every((error) => error instanceof OrganizationNotAvailableError)).toBe(true);
    expect(new Set(failures.map((error) => JSON.stringify(error)))).toHaveLength(1);
  });

  it('does not expose tenant rows to the global runtime role without an authenticated user context', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE uco_app');
      const rows = await client.query('SELECT * FROM identity_api.list_active_memberships()');
      expect(rows.rows).toEqual([]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});
