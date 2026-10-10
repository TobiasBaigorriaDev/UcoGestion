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
import { BranchReadService } from '../src/modules/branches/branch-read.service.js';
import { BranchDeactivationService } from '../src/modules/branches/branch-deactivation.service.js';
import { CashOperationsService } from '../src/modules/cash/cash-operations.service.js';
import { CatalogItemCreationService } from '../src/modules/catalog/catalog-item-creation.service.js';
import { InventoryIncreaseService } from '../src/modules/inventory/inventory-increase.service.js';
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
  let reader: BranchReadService;
  const operationPolicy = new BranchOperationPolicy();
  const context = () => ({ organizationId: organizationA, userId: ownerAUserId, requestId: 'branch-deactivation' });

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
    reader = new BranchReadService(new TenantTransaction(runtimePool));
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

  it('reads only active assigned branches for an operational member and stays inside the tenant', async () => {
    const assigned = randomUUID();
    const unassigned = randomUUID();
    const foreign = randomUUID();
    const userId = randomUUID();
    const membershipId = randomUUID();
    await pool.query(`INSERT INTO branches (id, organization_id, name) VALUES
      ($1, $2, 'Assigned'), ($3, $2, 'Unassigned'), ($4, $5, 'Foreign')`, [assigned, organizationA, unassigned, foreign, organizationB]);
    await pool.query('INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, $2, $3, 1)', [userId, `${userId}@example.com`, '$argon2id$v=19$branch']);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'EMPLOYEE')", [membershipId, organizationA, userId]);
    await pool.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)', [organizationA, membershipId, assigned]);
    const result = await reader.read({ organizationId: organizationA, requestId: 'branch-read-scope', userId });
    expect(result.actorRole).toBe('EMPLOYEE');
    expect(result.branches.map((branch) => branch.id)).toEqual([assigned]);
  });

  it('replays branch creation once without duplicate audit effects', async () => {
    const context = { organizationId: organizationA, requestId: 'branch-idempotent', userId: ownerAUserId };
    const name = `Replay ${randomUUID()}`;
    const first = await service.create(context, { name }, 'branch-replay-key');
    expect(await service.create({ ...context, requestId: 'branch-idempotent-retry' }, { name }, 'branch-replay-key')).toEqual(first);
    await expect(service.create(context, { name: `${name} changed` }, 'branch-replay-key')).rejects.toThrow('different payload');
    const audit = await pool.query<{ count: string }>('SELECT count(*) FROM audit_events WHERE entity_id = $1', [first.id]);
    expect(audit.rows[0]?.count).toBe('1');
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
       WHERE organization_id = ANY($1::uuid[]) AND name_norm = 'centro' ORDER BY organization_id`,
      [[organizationA, organizationB]],
    );
    expect(stored.rows).toEqual([
      { name: 'Centro', name_norm: 'centro', organization_id: organizationA },
      { name: 'CENTRO', name_norm: 'centro', organization_id: organizationB },
    ].sort((left, right) => left.organization_id.localeCompare(right.organization_id)));
  });

  it('T221 deactivates only OWNER tenant branches, with atomic audit, version and idempotent replay', async () => {
    const deactivation = new BranchDeactivationService(new TenantTransaction(runtimePool));
    const branch = await service.create(context(), { name: `Deactivate ${randomUUID()}` });
    const result = await deactivation.deactivate(context(), branch.id, 1, 'branch-deactivate');
    expect(result).toMatchObject({ id: branch.id, status: 'INACTIVE', version: 2 });
    await expect(service.create(context(), { name: `  ${branch.name.toUpperCase()}  ` }))
      .rejects.toMatchObject({ code: 'BRANCH_NAME_CONFLICT' });
    expect(await deactivation.deactivate(context(), branch.id, 1, 'branch-deactivate')).toEqual(result);
    await expect(deactivation.deactivate(context(), branch.id, 2, 'new-key-inactive')).rejects.toMatchObject({ code: 'BRANCH_VERSION_CONFLICT' });
    await expect(deactivation.deactivate(context(), branch.id, 2, 'branch-deactivate')).rejects.toThrow();
    await expect(deactivation.deactivate({ ...context(), organizationId: organizationB, userId: ownerBUserId }, branch.id, 2, 'foreign-deactivate')).rejects.toMatchObject({ code: 'BRANCH_NOT_AVAILABLE' });
    const audits = await pool.query("SELECT count(*) FROM audit_events WHERE entity_id=$1 AND action='branch.deactivated'", [branch.id]);
    expect(audits.rows[0]?.count).toBe('1');
    await expect(requireOperationalBranch(organizationA, ownerAUserId, branch.id)).rejects.toMatchObject({ code: 'BRANCH_INACTIVE' });
  });

  it('T221 denies ADMIN, CASHIER and EMPLOYEE even with branch assignment', async () => {
    const branch = await service.create(context(), { name: `Roles ${randomUUID()}` });
    const deactivation = new BranchDeactivationService(new TenantTransaction(runtimePool));
    for (const role of ['ADMIN', 'CASHIER', 'EMPLOYEE']) {
      const user = randomUUID(), membership = randomUUID();
      await pool.query('INSERT INTO users (id,email_normalized,password_hash,password_hash_version) VALUES ($1,$2,$3,1)', [user, `${user}@test.invalid`, '$argon2id$v=19$fixture']);
      await pool.query('INSERT INTO memberships (id,organization_id,user_id,role) VALUES ($1,$2,$3,$4)', [membership, organizationA, user, role]);
      await pool.query('INSERT INTO membership_branches (organization_id,membership_id,branch_id) VALUES ($1,$2,$3)', [organizationA,membership,branch.id]);
      await expect(deactivation.deactivate({ ...context(), userId: user }, branch.id, 1, `deny-${role}`)).rejects.toMatchObject({ code: 'BRANCH_DEACTIVATION_FORBIDDEN' });
    }
    expect((await pool.query('SELECT status FROM branches WHERE id=$1', [branch.id])).rows[0]?.status).toBe('ACTIVE');
  });

  it('T221 retains uncertainty for expired/revoked grants and never clears exposure to permit deactivation', async () => {
    const deactivation = new BranchDeactivationService(new TenantTransaction(runtimePool));
    const branch = await service.create(context(), { name: `Uncertain ${randomUUID()}` });
    const device = randomUUID(), grant = randomUUID(), exposure = randomUUID();
    await pool.query("INSERT INTO devices (id,organization_id,branch_id,status,public_key,authorized_by_user_id,authorized_at) VALUES ($1,$2,$3,'UNRECOVERABLE','fixture-key',$4,now())", [device,organizationA,branch.id,ownerAUserId]);
    const version = (await pool.query("INSERT INTO configuration_versions (id,organization_id,version,snapshot,canonical_payload,signature,signing_key_id,public_key_pem) VALUES ($1,$2,998,'{\"currency\":\"ARS\"}','{\"currency\":\"ARS\"}','fixture','fixture','fixture') RETURNING version", [randomUUID(),organizationA])).rows[0]?.version;
    await pool.query("INSERT INTO offline_grants (id,organization_id,device_id,epoch,configuration_version,expires_at,revoked_at) VALUES ($1,$2,$3,1,$4,now()-interval '1 day',now())", [grant,organizationA,device,version]);
    await pool.query("INSERT INTO sync_operations (id,organization_id,device_id,grant_id,epoch,sequence,prev_hash,operation_hash,status,occurred_at) VALUES ($1,$2,$3,$4,1,1,$5,$6,'PENDING',now()-interval '2 days')", [randomUUID(),organizationA,device,grant,'0'.repeat(64),'1'.repeat(64)]);
    expect((await deactivation.blockers(context(), branch.id)).pending).toBe('1');
    await expect(deactivation.deactivate(context(), branch.id, 1, 'pending-only')).rejects.toMatchObject({ code: 'BRANCH_DEACTIVATION_BLOCKED' });
    await pool.query('INSERT INTO offline_configuration_exposures (id,organization_id,device_id,grant_id,epoch,configuration_version) VALUES ($1,$2,$3,$4,1,$5)', [exposure,organizationA,device,grant,version]);
    await pool.query('INSERT INTO offline_exposure_resources (id,organization_id,exposure_id,branch_id) VALUES ($1,$2,$3,$4)', [randomUUID(),organizationA,exposure,branch.id]);
    await expect(deactivation.deactivate(context(), branch.id, 1, 'branch-uncertain')).rejects.toMatchObject({ code: 'BRANCH_DEACTIVATION_BLOCKED' });
    expect((await pool.query('SELECT status,version::integer AS version FROM branches WHERE id=$1', [branch.id])).rows[0]).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect((await pool.query('SELECT cleared_at FROM offline_configuration_exposures WHERE id=$1', [exposure])).rows[0]?.cleared_at).toBeNull();
    const counts = await deactivation.blockers(context(), branch.id);
    expect(counts.uncertainty).toBe('1');
    const unrelated = await service.create(context(), { name: `Clear ${randomUUID()}` });
    expect((await deactivation.deactivate(context(), unrelated.id, 1, 'clear-unrelated')).status).toBe('INACTIVE');
  });

  it('T221 audit failure rolls back branch status and idempotency; retry commits once', async () => {
    const deactivation = new BranchDeactivationService(new TenantTransaction(runtimePool));
    const branch = await service.create(context(), { name: `Audit failure ${randomUUID()}` });
    await pool.query("CREATE FUNCTION reject_branch_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='branch.deactivated' THEN RAISE EXCEPTION 'audit failure'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER reject_branch_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_branch_audit()');
    try { await expect(deactivation.deactivate(context(), branch.id, 1, 'branch-audit-failure')).rejects.toThrow('audit failure'); }
    finally { await pool.query('DROP TRIGGER reject_branch_audit ON audit_events'); await pool.query('DROP FUNCTION reject_branch_audit()'); }
    expect((await pool.query('SELECT status,version::integer AS version FROM branches WHERE id=$1', [branch.id])).rows[0]).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect((await pool.query("SELECT count(*) FROM idempotency_records WHERE organization_id=$1 AND scope='branch.deactivate' AND key='branch-audit-failure'", [organizationA])).rows[0]?.count).toBe('0');
    expect((await deactivation.deactivate(context(), branch.id, 1, 'branch-audit-failure')).status).toBe('INACTIVE');
  });

  it('T221 a real concurrent opening and branch deactivation cannot both commit', async () => {
    const transactions = new TenantTransaction(runtimePool);
    const deactivation = new BranchDeactivationService(transactions), cash = new CashOperationsService(transactions);
    const branch = await service.create(context(), { name: `Race ${randomUUID()}` });
    const register = randomUUID(), device = randomUUID();
    await pool.query('INSERT INTO cash_registers (id,organization_id,branch_id,name) VALUES ($1,$2,$3,$4)', [register,organizationA,branch.id,'Race register']);
    await pool.query("INSERT INTO devices (id,organization_id,branch_id,status,authorized_by_user_id,authorized_at) VALUES ($1,$2,$3,'ACTIVE',$4,now())", [device,organizationA,branch.id,ownerAUserId]);
    const results = await Promise.allSettled([
      deactivation.deactivate(context(), branch.id, 1, 'branch-race'),
      cash.open(context(), { branchId: branch.id, cashRegisterId: register, deviceId: device, openingCash: '0.00' }, 'branch-race-open'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const state = (await pool.query("SELECT b.status,(SELECT count(*) FROM cash_sessions s WHERE s.branch_id=b.id AND s.status='OPEN') AS open FROM branches b WHERE b.id=$1", [branch.id])).rows[0];
    expect(state.status === 'INACTIVE' ? state.open === '0' : state.open === '1').toBe(true);
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

  it('T221 blocks inventory conflicts and preserves their historical projection', async () => {
    const tx = new TenantTransaction(runtimePool);
    const branch = await service.create(context(), { name: `Incident ${randomUUID()}` });
    const item = await new CatalogItemCreationService(tx).create(context(), { name: 'Incident item', type: 'PRODUCT', trackInventory: true });
    const incident = randomUUID();
    await pool.query("INSERT INTO inventory_incidents (id,organization_id,branch_id,item_id,status,max_shortfall) VALUES ($1,$2,$3,$4,'OPEN',1)", [incident,organizationA,branch.id,item.id]);
    const deactivation = new BranchDeactivationService(tx);
    expect((await deactivation.blockers(context(), branch.id)).conflicts).toBe('1');
    await expect(deactivation.deactivate(context(), branch.id, 1, 'incident-blocked')).rejects.toMatchObject({ code: 'BRANCH_DEACTIVATION_BLOCKED' });
    expect((await pool.query('SELECT status FROM inventory_incidents WHERE id=$1', [incident])).rows[0]?.status).toBe('OPEN');
    expect((await pool.query('SELECT quantity FROM branch_stocks WHERE branch_id=$1 AND item_id=$2', [branch.id,item.id])).rows[0]?.quantity).toBe('0.000');
  });

  it('T221 prevents a new inventory write that waits behind committed deactivation', async () => {
    const tx = new TenantTransaction(runtimePool);
    const branch = await service.create(context(), { name: `Inventory race ${randomUUID()}` });
    const item = await new CatalogItemCreationService(tx).create(context(), { name: 'Race item', type: 'PRODUCT', trackInventory: true });
    const held = await pool.connect();
    try {
      await held.query('BEGIN');
      await held.query("UPDATE branches SET status='INACTIVE',version=version+1 WHERE id=$1", [branch.id]);
      const writing = new InventoryIncreaseService(tx).confirm(context(), { branchId: branch.id, itemId: item.id, quantity: '1.000', reason: 'Waiting write' }, 'waiting-inventory');
      const rejected = expect(writing).rejects.toThrow('Sucursal no autorizada');
      await held.query('COMMIT'); await rejected;
      expect((await pool.query('SELECT quantity FROM branch_stocks WHERE branch_id=$1 AND item_id=$2', [branch.id,item.id])).rows[0]?.quantity).toBe('0.000');
      expect((await pool.query('SELECT count(*) FROM inventory_movements WHERE branch_id=$1 AND item_id=$2', [branch.id,item.id])).rows[0]?.count).toBe('0');
    } finally { await held.query('ROLLBACK'); held.release(); }
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
