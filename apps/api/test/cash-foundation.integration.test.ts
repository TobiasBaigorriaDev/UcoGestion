import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { DeviceAuthorizationService } from '../src/modules/cash/device-authorization.service.js';
import { CashOpeningPreparation } from '../src/modules/cash/cash-opening-preparation.js';
import { CashSessionDevicePolicy } from '../src/modules/cash/cash-session-device.policy.js';

describe('cash foundation', () => {
  let container: StartedPostgreSqlContainer;
  let admin: Pool;
  let runtime: Pool;
  let devices: DeviceAuthorizationService;
  const organizationId = randomUUID();
  const foreignOrganizationId = randomUUID();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const cashierId = randomUUID();
  const employeeId = randomUUID();
  const branchId = randomUUID();
  const otherBranchId = randomUUID();
  const foreignBranchId = randomUUID();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    admin = new Pool({ connectionString: container.getConnectionUri() });
    await admin.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri());
    url.username = 'uco_runtime';
    url.password = 'runtime-password';
    runtime = new Pool({ connectionString: url.toString() });
    devices = new DeviceAuthorizationService(new TenantTransaction(runtime));
    await admin.query(`INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
      ($1, 'cash-owner@example.com', '$argon2id$v=19$owner', 1),
      ($2, 'cash-admin@example.com', '$argon2id$v=19$admin', 1),
      ($3, 'cash-employee@example.com', '$argon2id$v=19$employee', 1),
      ($4, 'cash-cashier@example.com', '$argon2id$v=19$cashier', 1)`, [ownerId, adminId, employeeId, cashierId]);
    await admin.query(`INSERT INTO organizations (id, base_currency, timezone) VALUES
      ($1, 'ARS', 'UTC'), ($2, 'ARS', 'UTC')`, [organizationId, foreignOrganizationId]);
    const adminMembership = randomUUID();
    const cashierMembership = randomUUID();
    await admin.query(`INSERT INTO memberships (id, organization_id, user_id, role) VALUES
      ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'ADMIN'), ($6, $2, $7, 'EMPLOYEE'),
      ($8, $2, $9, 'CASHIER')`,
    [randomUUID(), organizationId, ownerId, adminMembership, adminId, randomUUID(), employeeId,
      cashierMembership, cashierId]);
    await admin.query(`INSERT INTO branches (id, organization_id, name) VALUES
      ($1, $2, 'A'), ($3, $2, 'B'), ($4, $5, 'Foreign')`,
    [branchId, organizationId, otherBranchId, foreignBranchId, foreignOrganizationId]);
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationId, adminMembership, branchId]);
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationId, cashierMembership, branchId]);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
    await container?.stop();
  });

  const context = (userId: string) => ({ organizationId, userId, requestId: randomUUID() });

  it('T115 authorizes an online device with tenant, branch, authorizer and contact timestamps', async () => {
    const device = await devices.authorizeOnline(context(ownerId), branchId);
    expect(device).toMatchObject({ organizationId, branchId, authorizedByUserId: ownerId, status: 'ACTIVE' });
    const row = await admin.query('SELECT authorized_at, last_seen_at, last_sync_at FROM devices WHERE id = $1', [device.id]);
    expect(row.rows[0]?.authorized_at).toBeInstanceOf(Date);
    expect(row.rows[0]?.last_seen_at).toBeNull();
    expect(row.rows[0]?.last_sync_at).toBeNull();
    await expect(devices.authorizeOnline(context(employeeId), branchId)).rejects.toMatchObject({ code: 'DEVICE_AUTHORIZATION_FORBIDDEN' });
    await expect(devices.authorizeOnline(context(adminId), otherBranchId)).rejects.toMatchObject({ code: 'DEVICE_BRANCH_FORBIDDEN' });
    await expect(devices.authorizeOnline(context(ownerId), foreignBranchId)).rejects.toMatchObject({ code: 'DEVICE_BRANCH_NOT_AVAILABLE' });
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [foreignOrganizationId]);
      expect((await client.query('SELECT id FROM devices WHERE id = $1', [device.id])).rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it('T116 preserves a conflicting offline session while one normal session blocks online opening', async () => {
    const registerId = randomUUID();
    const firstDevice = await devices.authorizeOnline(context(ownerId), branchId);
    const secondDevice = await devices.authorizeOnline(context(ownerId), branchId);
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, $4)',
      [registerId, organizationId, branchId, 'Main']);
    const insert = (id: string, deviceId: string, origin: string, status: string) => admin.query(
      `INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id, owner_user_id,
        device_id, origin, status, opening_cash, expected_cash, currency_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '10.00', '10.00', 'ARS')`,
      [id, organizationId, branchId, registerId, ownerId, deviceId, origin, status]);
    const normalId = randomUUID();
    const conflictId = randomUUID();
    await insert(normalId, firstDevice.id, 'ONLINE', 'OPEN');
    await expect(insert(randomUUID(), secondDevice.id, 'ONLINE', 'OPEN')).rejects.toMatchObject({ code: '23505' });
    await insert(conflictId, secondDevice.id, 'OFFLINE', 'CONFLICTED');
    await expect(admin.query(`INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id,
      owner_user_id, device_id, origin, status, opening_cash, expected_cash, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, 'OFFLINE', 'CONFLICTED', '10.00', '10.00', 'ARS')`,
    [randomUUID(), foreignOrganizationId, branchId, registerId, ownerId, secondDevice.id]))
      .rejects.toMatchObject({ code: '23503' });
    const rows = await admin.query<{ id: string; status: string }>(
      'SELECT id, status FROM cash_sessions WHERE cash_register_id = $1 ORDER BY id', [registerId]);
    expect(rows.rows).toEqual(expect.arrayContaining([
      { id: normalId, status: 'OPEN' }, { id: conflictId, status: 'CONFLICTED' },
    ]));
    await expect(admin.query("UPDATE cash_sessions SET status = 'CLOSED' WHERE id = $1", [normalId]))
      .rejects.toMatchObject({ code: '55000' });
    await admin.query(`INSERT INTO cash_session_state_transitions
      (id, organization_id, cash_session_id, actor_user_id, from_status, to_status)
      VALUES ($1, $2, $3, $4, 'OPEN', 'CLOSING')`, [randomUUID(), organizationId, normalId, ownerId]);
    await expect(admin.query('DELETE FROM cash_session_state_transitions WHERE cash_session_id = $1', [normalId]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(insert(randomUUID(), secondDevice.id, 'ONLINE', 'OPEN')).rejects.toMatchObject({ code: '23505' });
  });

  it('T117 keeps cash movements immutable and expected cash atomic', async () => {
    const registerId = randomUUID();
    const device = await devices.authorizeOnline(context(ownerId), branchId);
    const sessionId = randomUUID();
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, $4)',
      [registerId, organizationId, branchId, 'Ledger']);
    await admin.query(`INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id,
      owner_user_id, device_id, origin, status, opening_cash, expected_cash, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', '10.00', '10.00', 'ARS')`,
    [sessionId, organizationId, branchId, registerId, ownerId, device.id]);
    const sourceId = randomUUID();
    const insert = (id: string, source: string, delta: string, effect: string) => admin.query(
      `INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id, actor_user_id,
        device_id, delta, currency_code, source_type, source_id, effect_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ARS', 'MANUAL', $8, $9)`,
      [id, organizationId, branchId, sessionId, ownerId, device.id, delta, source, effect]);
    const movementId = randomUUID();
    await insert(movementId, sourceId, '2.00', 'IN');
    expect((await admin.query<{ expected_cash: string }>('SELECT expected_cash FROM cash_sessions WHERE id = $1', [sessionId]))
      .rows[0]?.expected_cash).toBe('12.00');
    await withRuntime(ownerId, async (client) => {
      await client.query(`INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id,
        actor_user_id, device_id, delta, currency_code, source_type, source_id, effect_kind)
        VALUES ($1, $2, $3, $4, $5, $6, '1.00', 'ARS', 'MANUAL', $7, 'IN')`,
      [randomUUID(), organizationId, branchId, sessionId, ownerId, device.id, randomUUID()]);
      expect((await client.query<{ expected_cash: string }>(
        'SELECT expected_cash FROM cash_sessions WHERE id = $1', [sessionId])).rows[0]?.expected_cash).toBe('13.00');
    });
    expect((await admin.query<{ expected_cash: string }>('SELECT expected_cash FROM cash_sessions WHERE id = $1', [sessionId]))
      .rows[0]?.expected_cash).toBe('12.00');
    await expect(insert(randomUUID(), sourceId, '2.00', 'IN')).rejects.toMatchObject({ code: '23505' });
    await expect(insert(randomUUID(), randomUUID(), '-13.00', 'OUT')).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id,
      actor_user_id, device_id, delta, currency_code, source_type, source_id, effect_kind)
      VALUES ($1, $2, $3, $4, $5, $6, '1.00', 'USD', 'MANUAL', $7, 'IN')`,
    [randomUUID(), organizationId, branchId, sessionId, ownerId, device.id, randomUUID()]))
      .rejects.toMatchObject({ code: '23514' });
    expect((await admin.query<{ expected_cash: string }>('SELECT expected_cash FROM cash_sessions WHERE id = $1', [sessionId]))
      .rows[0]?.expected_cash).toBe('12.00');
    await expect(admin.query('UPDATE cash_sessions SET expected_cash = 99 WHERE id = $1', [sessionId]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(admin.query('UPDATE cash_movements SET delta = 3 WHERE id = $1', [movementId]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(admin.query('DELETE FROM cash_movements WHERE id = $1', [movementId]))
      .rejects.toMatchObject({ code: '55000' });
    await admin.query(`INSERT INTO cash_session_state_transitions
      (id, organization_id, cash_session_id, actor_user_id, from_status, to_status)
      VALUES ($1, $2, $3, $4, 'OPEN', 'CLOSING')`, [randomUUID(), organizationId, sessionId, ownerId]);
    await admin.query(`INSERT INTO cash_session_state_transitions
      (id, organization_id, cash_session_id, actor_user_id, from_status, to_status)
      VALUES ($1, $2, $3, $4, 'CLOSING', 'CLOSED')`, [randomUUID(), organizationId, sessionId, ownerId]);
    await expect(insert(randomUUID(), randomUUID(), '1.00', 'IN')).rejects.toMatchObject({ code: '23514' });
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [foreignOrganizationId]);
      expect((await client.query('SELECT id FROM cash_movements WHERE id = $1', [movementId])).rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it('T118 prepares an online opening with nonnegative cash and matching active register and device', async () => {
    const registerId = randomUUID();
    const device = await devices.authorizeOnline(context(ownerId), branchId);
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, $4)',
      [registerId, organizationId, branchId, 'Opening']);
    const preparation = new CashOpeningPreparation();
    const input = { branchId, cashRegisterId: registerId, deviceId: device.id, openingCash: '0.00' };
    await withRuntime(ownerId, async (client) => {
      expect(await preparation.prepare(client, context(ownerId), input)).toMatchObject({
        ...input, ownerUserId: ownerId, organizationId, origin: 'ONLINE', status: 'OPEN',
      });
      expect((await preparation.prepare(client, context(ownerId), { ...input, openingCash: '1' })).openingCash)
        .toBe('1.00');
      await expect(preparation.prepare(client, context(ownerId), { ...input, openingCash: '-0.01' }))
        .rejects.toMatchObject({ code: 'CASH_OPENING_AMOUNT_INVALID' });
      await expect(preparation.prepare(client, context(ownerId), { ...input, branchId: otherBranchId }))
        .rejects.toMatchObject({ code: 'CASH_OPENING_BRANCH_MISMATCH' });
    });
    await withRuntime(ownerId, async (client) => {
      await expect(preparation.prepare(client, context(ownerId), { ...input, deviceId: randomUUID() }))
        .rejects.toMatchObject({ code: 'CASH_OPENING_DEVICE_NOT_AVAILABLE' });
    });
  });

  it('T116 rejects online opening when a conflicted offline session remains', async () => {
    const registerId = randomUUID();
    const device = await devices.authorizeOnline(context(ownerId), branchId);
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, $4)',
      [registerId, organizationId, branchId, 'Conflict gate']);
    await admin.query(`INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id,
      owner_user_id, device_id, origin, status, opening_cash, expected_cash, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, 'OFFLINE', 'CONFLICTED', '0.00', '0.00', 'ARS')`,
    [randomUUID(), organizationId, branchId, registerId, ownerId, device.id]);
    await withRuntime(ownerId, async (client) => {
      await expect(new CashOpeningPreparation().prepare(client, context(ownerId), {
        branchId, cashRegisterId: registerId, deviceId: device.id, openingCash: '0.00',
      })).rejects.toMatchObject({ code: 'CASH_OPENING_ALREADY_ACTIVE' });
    });
  });

  it('T119 permits scoped OWNER, ADMIN and CASHIER opening while rejecting EMPLOYEE', async () => {
    const firstRegister = randomUUID();
    const secondRegister = randomUUID();
    const firstDevice = await devices.authorizeOnline(context(ownerId), branchId);
    const secondDevice = await devices.authorizeOnline(context(ownerId), otherBranchId);
    await admin.query(`INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES
      ($1, $2, $3, 'Scope A'), ($4, $2, $5, 'Scope B')`,
    [firstRegister, organizationId, branchId, secondRegister, otherBranchId]);
    const preparation = new CashOpeningPreparation();
    const first = { branchId, cashRegisterId: firstRegister, deviceId: firstDevice.id, openingCash: '1.00' };
    const second = { branchId: otherBranchId, cashRegisterId: secondRegister,
      deviceId: secondDevice.id, openingCash: '1.00' };
    await withRuntime(ownerId, async (client) => {
      await expect(preparation.prepare(client, context(ownerId), second)).resolves.toMatchObject({ ownerUserId: ownerId });
    });
    await withRuntime(adminId, async (client) => {
      await expect(preparation.prepare(client, context(adminId), first)).resolves.toMatchObject({ ownerUserId: adminId });
      await expect(preparation.prepare(client, context(adminId), second)).rejects.toMatchObject({ code: 'CASH_OPENING_FORBIDDEN' });
    });
    await withRuntime(cashierId, async (client) => {
      await expect(preparation.prepare(client, context(cashierId), first)).resolves.toMatchObject({ ownerUserId: cashierId });
      await expect(preparation.prepare(client, context(cashierId), second)).rejects.toMatchObject({ code: 'CASH_OPENING_FORBIDDEN' });
    });
    await withRuntime(employeeId, async (client) => {
      await expect(preparation.prepare(client, context(employeeId), first)).rejects.toMatchObject({ code: 'CASH_OPENING_FORBIDDEN' });
    });
  });

  it('T120 rejects an operation from another device even for OWNER or ADMIN', async () => {
    const registerId = randomUUID();
    const sessionId = randomUUID();
    const owningDevice = await devices.authorizeOnline(context(ownerId), branchId);
    const otherDevice = await devices.authorizeOnline(context(ownerId), branchId);
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, $4)',
      [registerId, organizationId, branchId, 'Device lock']);
    await admin.query(`INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id,
      owner_user_id, device_id, origin, status, opening_cash, expected_cash, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', '1.00', '1.00', 'ARS')`,
    [sessionId, organizationId, branchId, registerId, cashierId, owningDevice.id]);
    const policy = new CashSessionDevicePolicy();
    await withRuntime(ownerId, async (client) => {
      await expect(policy.requireOperational(client, organizationId, sessionId, otherDevice.id))
        .rejects.toMatchObject({ code: 'CASH_SESSION_DEVICE_CONFLICT' });
      await expect(policy.requireOperational(client, organizationId, sessionId, owningDevice.id))
        .resolves.toMatchObject({ id: sessionId, deviceId: owningDevice.id });
    });
    await withRuntime(adminId, async (client) => {
      await expect(policy.requireOperational(client, organizationId, sessionId, otherDevice.id))
        .rejects.toMatchObject({ code: 'CASH_SESSION_DEVICE_CONFLICT' });
    });
    await expect(admin.query(`INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id,
      actor_user_id, device_id, delta, currency_code, source_type, source_id, effect_kind)
      VALUES ($1, $2, $3, $4, $5, $6, '1.00', 'ARS', 'MANUAL', $7, 'IN')`,
    [randomUUID(), organizationId, branchId, sessionId, ownerId, otherDevice.id, randomUUID()]))
      .rejects.toMatchObject({ code: '23503' });
  });

  async function withRuntime<T>(userId: string, operation: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const result = await operation(client);
      await client.query('ROLLBACK');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
});
