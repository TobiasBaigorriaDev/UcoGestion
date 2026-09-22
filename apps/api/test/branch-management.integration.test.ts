import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import {
  BranchManagementError,
  BranchManagementService,
} from '../src/modules/branches/branch-management.service.js';
import {
  BranchOperationError,
  BranchOperationPolicy,
} from '../src/modules/branches/branch-operation.policy.js';

describe('branch management', () => {
  let container: StartedPostgreSqlContainer;
  let organizationA: string;
  let organizationB: string;
  let ownerAUserId: string;
  let ownerBUserId: string;
  let pool: Pool;
  let runtimePool: Pool;
  let service: BranchManagementService;
  const operationPolicy = new BranchOperationPolicy();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'uco_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    service = new BranchManagementService(new TenantTransaction(runtimePool));
    organizationA = randomUUID();
    organizationB = randomUUID();
    ownerAUserId = randomUUID();
    ownerBUserId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'branch.owner.a@example.com', '$argon2id$v=19$owner-a', 1),
       ($2, 'branch.owner.b@example.com', '$argon2id$v=19$owner-b', 1)`,
      [ownerAUserId, ownerBUserId],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Branches A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Branches B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'), ($4, $5, $6, 'OWNER')`,
      [randomUUID(), organizationA, ownerAUserId, randomUUID(), organizationB, ownerBUserId],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('normalizes branch names and enforces uniqueness only inside the tenant', async () => {
    const created = await service.create(
      { organizationId: organizationA, requestId: 'branch-create-a', userId: ownerAUserId },
      { name: '  Centro  ' },
    );
    expect(created).toMatchObject({ name: 'Centro', status: 'ACTIVE', version: 1 });

    await expect(service.create(
      { organizationId: organizationA, requestId: 'branch-duplicate-a', userId: ownerAUserId },
      { name: 'cEnTrO' },
    )).rejects.toMatchObject({ code: 'BRANCH_NAME_CONFLICT' } satisfies Partial<BranchManagementError>);

    await expect(service.create(
      { organizationId: organizationB, requestId: 'branch-create-b', userId: ownerBUserId },
      { name: 'CENTRO' },
    )).resolves.toMatchObject({ name: 'CENTRO', status: 'ACTIVE' });

    const stored = await pool.query<{ name: string; name_norm: string; organization_id: string }>(
      `SELECT organization_id, name, name_norm FROM branches
       WHERE organization_id = ANY($1::uuid[]) ORDER BY organization_id`,
      [[organizationA, organizationB]],
    );
    expect(stored.rows).toEqual([
      { name: 'Centro', name_norm: 'centro', organization_id: organizationA },
      { name: 'CENTRO', name_norm: 'centro', organization_id: organizationB },
    ].sort((left, right) => left.organization_id.localeCompare(right.organization_id)));
  });

  it('allows new operations only on active branches without exposing a state-change command', async () => {
    const activeBranchId = randomUUID();
    const inactiveBranchId = randomUUID();
    const foreignBranchId = randomUUID();
    await pool.query(
      `INSERT INTO branches (id, organization_id, name, status) VALUES
       ($1, $2, 'Operational', 'ACTIVE'),
       ($3, $2, 'Historical only', 'INACTIVE'),
       ($4, $5, 'Foreign operational', 'ACTIVE')`,
      [activeBranchId, organizationA, inactiveBranchId, foreignBranchId, organizationB],
    );

    await expect(requireOperationalBranch(organizationA, ownerAUserId, activeBranchId))
      .resolves.toMatchObject({ id: activeBranchId, status: 'ACTIVE' });
    await expect(requireOperationalBranch(organizationA, ownerAUserId, inactiveBranchId))
      .rejects.toMatchObject({ code: 'BRANCH_INACTIVE' } satisfies Partial<BranchOperationError>);
    await expect(requireOperationalBranch(organizationA, ownerAUserId, foreignBranchId))
      .rejects.toMatchObject({ code: 'BRANCH_NOT_AVAILABLE' } satisfies Partial<BranchOperationError>);
    await expect(pool.query(
      "INSERT INTO branches (id, organization_id, name, status) VALUES ($1, $2, 'Invalid state', 'ARCHIVED')",
      [randomUUID(), organizationA],
    )).rejects.toThrow();
    expect('setStatus' in service).toBe(false);
  });

  async function requireOperationalBranch(
    organizationId: string,
    userId: string,
    branchId: string,
  ) {
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      await client.query("SELECT set_config('app.request_id', $1, true)", [`branch-operation:${branchId}`]);
      const result = await operationPolicy.requireActive(client, organizationId, branchId);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
});
