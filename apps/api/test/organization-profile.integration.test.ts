import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import {
  OrganizationProfilePermissionError,
  OrganizationProfileService,
  OrganizationProfileVersionError,
  organizationProfileUpdateSchema,
} from '../src/modules/organizations/organization-profile.service.js';
import { OrganizationSettingsService } from '../src/modules/organizations/organization-settings.service.js';

describe('organization commercial profile', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let service: OrganizationProfileService;
  let organizationA: string;
  let organizationB: string;
  let ownerUserId: string;
  let adminUserId: string;
  let cashierUserId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    service = new OrganizationProfileService(new TenantTransaction(pool));
    organizationA = randomUUID();
    organizationB = randomUUID();
    ownerUserId = (await createGlobalUser(pool, { email: 'profile-owner@example.com', password: 'user-password' })).id;
    adminUserId = (await createGlobalUser(pool, { email: 'profile-admin@example.com', password: 'user-password' })).id;
    cashierUserId = (await createGlobalUser(pool, { email: 'profile-cashier@example.com', password: 'user-password' })).id;
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Profile A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Profile B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'ADMIN'), ($6, $2, $7, 'CASHIER')`,
      [randomUUID(), organizationA, ownerUserId, randomUUID(), adminUserId, randomUUID(), cashierUserId],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('lets OWNER and ADMIN update only commercial fields with versioning and audit', async () => {
    const ownerResult = await service.update(
      { organizationId: organizationA, requestId: 'profile-owner-001', userId: ownerUserId },
      1,
      { address: 'San Martín 123', displayName: 'Uco Centro', email: 'ventas@example.com', phone: '+54 261 555 0101' },
    );
    expect(ownerResult).toMatchObject({ profile: { displayName: 'Uco Centro' }, version: 2 });

    const adminResult = await service.update(
      { organizationId: organizationA, requestId: 'profile-admin-001', userId: adminUserId },
      2,
      { address: 'San Martín 456', displayName: 'Uco Centro', email: 'ventas@example.com', phone: null },
    );
    expect(adminResult).toMatchObject({ profile: { address: 'San Martín 456', phone: null }, version: 3 });
    expect(
      await pool.query<{ count: string }>(
        "SELECT count(*) FROM audit_events WHERE organization_id = $1 AND action = 'organization.profile_updated'",
        [organizationA],
      ),
    ).toMatchObject({ rows: [{ count: '2' }] });
  });

  it('rejects operational roles, structural fields and stale versions without cross-tenant effects', async () => {
    await expect(service.update(
      { organizationId: organizationA, requestId: 'profile-cashier-001', userId: cashierUserId },
      3,
      { displayName: 'Denied' },
    )).rejects.toBeInstanceOf(OrganizationProfilePermissionError);

    expect(() => organizationProfileUpdateSchema.parse({ baseCurrency: 'USD', displayName: 'Invalid' })).toThrow();
    expect(() => organizationProfileUpdateSchema.parse({ displayName: 'Invalid', timezone: 'UTC' })).toThrow();

    await expect(service.update(
      { organizationId: organizationA, requestId: 'profile-stale-001', userId: ownerUserId },
      1,
      { displayName: 'Stale' },
    )).rejects.toBeInstanceOf(OrganizationProfileVersionError);

    const other = await pool.query<{ profile: Record<string, unknown>; version: string }>(
      'SELECT profile, version::text FROM organizations WHERE id = $1',
      [organizationB],
    );
    expect(other.rows[0]).toEqual({ profile: {}, version: '1' });
  });

  it('reads profile, timezone and version only for an active member of that tenant', async () => {
    const reader = new OrganizationSettingsService(new TenantTransaction(pool));
    await expect(reader.read({ organizationId: organizationA, requestId: 'settings-read', userId: ownerUserId }))
      .resolves.toMatchObject({ timezone: 'America/Argentina/Mendoza', version: 3, role: 'OWNER' });
    await expect(reader.read({ organizationId: organizationB, requestId: 'settings-cross-tenant', userId: ownerUserId }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});
