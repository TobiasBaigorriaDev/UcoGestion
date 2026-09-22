import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import {
  CashRegisterManagementError,
  CashRegisterManagementService,
} from '../src/modules/branches/cash-register-management.service.js';
import {
  CashRegisterOperationError,
  CashRegisterOperationPolicy,
} from '../src/modules/branches/cash-register-operation.policy.js';

describe('cash register management', () => {
  let container: StartedPostgreSqlContainer;
  let organizationA: string;
  let organizationB: string;
  let ownerAUserId: string;
  let adminAUserId: string;
  let adminAMembershipId: string;
  let ownerBUserId: string;
  let branchA: string;
  let secondBranchA: string;
  let branchB: string;
  let pool: Pool;
  let runtimePool: Pool;
  let service: CashRegisterManagementService;
  const operationPolicy = new CashRegisterOperationPolicy();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'uco_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    service = new CashRegisterManagementService(new TenantTransaction(runtimePool));

    organizationA = randomUUID();
    organizationB = randomUUID();
    ownerAUserId = randomUUID();
    adminAUserId = randomUUID();
    ownerBUserId = randomUUID();
    branchA = randomUUID();
    secondBranchA = randomUUID();
    branchB = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'register.owner.a@example.com', '$argon2id$v=19$owner-a', 1),
       ($2, 'register.admin.a@example.com', '$argon2id$v=19$admin-a', 1),
       ($3, 'register.owner.b@example.com', '$argon2id$v=19$owner-b', 1)`,
      [ownerAUserId, adminAUserId, ownerBUserId],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Registers A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Registers B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'),
       ($4, $2, $5, 'ADMIN'),
       ($6, $7, $8, 'OWNER')`,
      [
        randomUUID(), organizationA, ownerAUserId,
        randomUUID(), adminAUserId,
        randomUUID(), organizationB, ownerBUserId,
      ],
    );
    await pool.query(
      `INSERT INTO branches (id, organization_id, name, status) VALUES
       ($1, $2, 'Centro', 'ACTIVE'),
       ($3, $2, 'Norte', 'ACTIVE'),
       ($4, $5, 'Centro', 'ACTIVE')`,
      [branchA, organizationA, secondBranchA, branchB, organizationB],
    );
    const adminMembership = await pool.query<{ id: string }>(
      'SELECT id FROM memberships WHERE organization_id = $1 AND user_id = $2',
      [organizationA, adminAUserId],
    );
    const adminMembershipId = adminMembership.rows.at(0)?.id;
    if (!adminMembershipId) throw new Error('La membresía ADMIN no fue persistida.');
    adminAMembershipId = adminMembershipId;
    await pool.query(
      'INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationA, adminAMembershipId, branchA],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('creates and renames registers with normalized uniqueness per branch', async () => {
    const created = await service.create(context(ownerAUserId, 'register-create'), {
      branchId: branchA,
      name: '  Principal  ',
    });
    expect(created).toMatchObject({
      branchId: branchA,
      name: 'Principal',
      status: 'ACTIVE',
      version: 1,
    });

    await expect(service.create(context(ownerAUserId, 'register-duplicate'), {
      branchId: branchA,
      name: 'principal',
    })).rejects.toMatchObject({
      code: 'CASH_REGISTER_NAME_CONFLICT',
    } satisfies Partial<CashRegisterManagementError>);

    await expect(service.create(context(ownerAUserId, 'register-other-branch'), {
      branchId: secondBranchA,
      name: 'PRINCIPAL',
    })).resolves.toMatchObject({ branchId: secondBranchA, name: 'PRINCIPAL' });

    await expect(service.rename(context(adminAUserId, 'register-rename'), created.id, {
      expectedVersion: 1,
      name: '  Mostrador  ',
    })).resolves.toMatchObject({ name: 'Mostrador', version: 2 });

    const stored = await pool.query<{ name: string; name_norm: string }>(
      'SELECT name, name_norm FROM cash_registers WHERE id = $1',
      [created.id],
    );
    expect(stored.rows).toEqual([{ name: 'Mostrador', name_norm: 'mostrador' }]);
  });

  it('rejects a foreign branch and unauthorized actor without leaking cross-tenant data', async () => {
    await expect(service.create(context(ownerAUserId, 'register-foreign'), {
      branchId: branchB,
      name: 'Foreign',
    })).rejects.toMatchObject({
      code: 'CASH_REGISTER_BRANCH_NOT_AVAILABLE',
    } satisfies Partial<CashRegisterManagementError>);

    await expect(service.create(context(randomUUID(), 'register-unauthorized'), {
      branchId: branchA,
      name: 'Denied',
    })).rejects.toMatchObject({
      code: 'CASH_REGISTER_MANAGEMENT_FORBIDDEN',
    } satisfies Partial<CashRegisterManagementError>);

    await expect(service.create(context(adminAUserId, 'register-out-of-scope'), {
      branchId: secondBranchA,
      name: 'Out of scope',
    })).rejects.toMatchObject({
      code: 'CASH_REGISTER_BRANCH_FORBIDDEN',
    } satisfies Partial<CashRegisterManagementError>);
  });

  it('deactivates a register without deleting it and blocks future openings', async () => {
    const created = await service.create(context(ownerAUserId, 'register-deactivate-create'), {
      branchId: branchA,
      name: 'Historical register',
    });
    const deactivated = await service.deactivate(
      context(adminAUserId, 'register-deactivate'),
      created.id,
      1,
    );
    expect(deactivated).toMatchObject({ id: created.id, status: 'INACTIVE', version: 2 });

    const stored = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM cash_registers WHERE id = $1',
      [created.id],
    );
    expect(stored.rows).toEqual([{ id: created.id, status: 'INACTIVE' }]);

    await expect(requireOpenableRegister(organizationA, adminAUserId, created.id))
      .rejects.toMatchObject({
        code: 'CASH_REGISTER_INACTIVE',
      } satisfies Partial<CashRegisterOperationError>);
    await expect(requireOpenableRegister(organizationA, adminAUserId, randomUUID()))
      .rejects.toMatchObject({
        code: 'CASH_REGISTER_NOT_AVAILABLE',
      } satisfies Partial<CashRegisterOperationError>);
  });

  function context(userId: string, requestId: string) {
    return { organizationId: organizationA, requestId, userId };
  }

  async function requireOpenableRegister(organizationId: string, userId: string, cashRegisterId: string) {
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      await client.query("SELECT set_config('app.request_id', $1, true)", [`register-open:${cashRegisterId}`]);
      const result = await operationPolicy.requireOpenable(client, organizationId, cashRegisterId);
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
