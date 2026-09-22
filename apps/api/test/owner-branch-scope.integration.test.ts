import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';

describe('OWNER branch scope projection', () => {
  let client: Client;
  let container: StartedPostgreSqlContainer;
  let organizationA: string;
  let organizationB: string;
  let ownerMembershipA: string;
  let ownerMembershipB: string;
  let adminMembershipA: string;
  let branchA1: string;
  let branchA2: string;
  let branchB: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();

    organizationA = randomUUID();
    organizationB = randomUUID();
    ownerMembershipA = randomUUID();
    ownerMembershipB = randomUUID();
    adminMembershipA = randomUUID();
    branchA1 = randomUUID();
    branchA2 = randomUUID();
    branchB = randomUUID();

    const ownerUserA = randomUUID();
    const ownerUserB = randomUUID();
    const adminUserA = randomUUID();
    await client.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'owner-a@example.com', '$argon2id$v=19$test', 1),
       ($2, 'owner-b@example.com', '$argon2id$v=19$test', 1),
       ($3, 'admin-a@example.com', '$argon2id$v=19$test', 1)`,
      [ownerUserA, ownerUserB, adminUserA],
    );
    await client.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Organization A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Organization B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );
    await client.query(
      `INSERT INTO branches (id, organization_id, name, status) VALUES
       ($1, $2, 'A active', 'ACTIVE'),
       ($3, $2, 'A inactive', 'INACTIVE'),
       ($4, $5, 'B active', 'ACTIVE')`,
      [branchA1, organizationA, branchA2, branchB, organizationB],
    );
    await client.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'),
       ($4, $5, $6, 'OWNER'),
       ($7, $2, $8, 'ADMIN')`,
      [
        ownerMembershipA,
        organizationA,
        ownerUserA,
        ownerMembershipB,
        organizationB,
        ownerUserB,
        adminMembershipA,
        adminUserA,
      ],
    );
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('projects every organization branch for OWNER without stored assignments', async () => {
    await expectOwnerScope([branchA1, branchA2]);

    const branchCreatedLater = randomUUID();
    await client.query(
      "INSERT INTO branches (id, organization_id, name, status) VALUES ($1, $2, 'A later', 'ACTIVE')",
      [branchCreatedLater, organizationA],
    );

    await expectOwnerScope([branchA1, branchA2, branchCreatedLater]);
    const assignments = await client.query<{ count: string }>(
      'SELECT count(*) FROM membership_branches WHERE organization_id = $1 AND membership_id = $2',
      [organizationA, ownerMembershipA],
    );
    expect(assignments.rows[0]?.count).toBe('0');
  });

  it('reserves explicit assignments for non-owners and rejects cross-tenant relationships', async () => {
    await expect(client.query(
      'INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationA, ownerMembershipA, branchA1],
    )).rejects.toThrow(/OWNER_BRANCH_ASSIGNMENT_NOT_ALLOWED/);

    await client.query(
      'INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationA, adminMembershipA, branchA1],
    );
    const adminScope = await client.query<{ branch_id: string }>(
      `SELECT branch_id FROM effective_membership_branch_scope
       WHERE organization_id = $1 AND membership_id = $2`,
      [organizationA, adminMembershipA],
    );
    expect(adminScope.rows).toEqual([{ branch_id: branchA1 }]);

    await expect(client.query(
      'INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationA, adminMembershipA, branchB],
    )).rejects.toThrow();
    await expect(client.query(
      "UPDATE memberships SET role = 'OWNER' WHERE organization_id = $1 AND id = $2",
      [organizationA, adminMembershipA],
    )).rejects.toThrow(/OWNER_BRANCH_ASSIGNMENT_NOT_ALLOWED/);
  });

  it('keeps the effective projection default-deny and tenant-isolated for the runtime role', async () => {
    await client.query('SET ROLE uco_app');
    try {
      const withoutContext = await client.query('SELECT * FROM effective_membership_branch_scope');
      expect(withoutContext.rows).toEqual([]);

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationA]);
      const scoped = await client.query<{ organization_id: string }>(
        'SELECT organization_id FROM effective_membership_branch_scope',
      );
      await client.query('COMMIT');

      expect(scoped.rows.length).toBeGreaterThan(0);
      expect(scoped.rows.every((row) => row.organization_id === organizationA)).toBe(true);
      expect(scoped.rows.some((row) => row.organization_id === organizationB)).toBe(false);
    } finally {
      await client.query('RESET ROLE');
    }
  });

  async function expectOwnerScope(expectedBranchIds: readonly string[]): Promise<void> {
    const scope = await client.query<{ branch_id: string }>(
      `SELECT branch_id FROM effective_membership_branch_scope
       WHERE organization_id = $1 AND membership_id = $2
       ORDER BY branch_id`,
      [organizationA, ownerMembershipA],
    );
    expect(scope.rows.map((row) => row.branch_id)).toEqual([...expectedBranchIds].sort());
  }
});
