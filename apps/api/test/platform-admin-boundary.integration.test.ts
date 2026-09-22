import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { PlatformDatabase } from '../src/modules/platform-admin/platform-database.js';
import { provisionOrganizationCommandSchema } from '../src/modules/platform-admin/provisioning.contract.js';

describe('platform administration boundary', () => {
  let container: StartedPostgreSqlContainer;
  let database: PlatformDatabase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    database = new PlatformDatabase({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    await database?.close();
    await container?.stop();
  });

  it('uses the dedicated restricted role without tenant or identity table access', async () => {
    await database.withClient(async (client) => {
      const identity = await client.query<{ current_user: string }>('SELECT current_user');
      expect(identity.rows[0]?.current_user).toBe('uco_platform');
      await expect(client.query('SELECT * FROM organizations')).rejects.toThrow();
      await expect(client.query('SELECT * FROM users')).rejects.toThrow();
      const memberships = await client.query<{ can_assume_app: boolean }>(
        "SELECT pg_has_role(current_user, 'uco_app', 'MEMBER') AS can_assume_app",
      );
      expect(memberships.rows[0]?.can_assume_app).toBe(false);
    });
  });

  it('defines a strict internal provisioning command without structural overrides', () => {
    expect(
      provisionOrganizationCommandSchema.parse({
        firstBranchName: 'Casa Central',
        organizationName: 'Comercial Andina',
        ownerEmail: 'owner@example.com',
        ownerPassword: 'a-secure-owner-password',
        requestId: 'provisioning-request-001',
        timezone: 'America/Argentina/Mendoza',
      }),
    ).toMatchObject({ organizationName: 'Comercial Andina', ownerEmail: 'owner@example.com' });

    expect(() =>
      provisionOrganizationCommandSchema.parse({
        baseCurrency: 'USD',
        firstBranchName: 'Casa Central',
        organizationName: 'Comercial Andina',
        ownerEmail: 'owner@example.com',
        ownerPassword: 'a-secure-owner-password',
        requestId: 'provisioning-request-001',
        timezone: 'America/Argentina/Mendoza',
      }),
    ).toThrow();
  });
});
