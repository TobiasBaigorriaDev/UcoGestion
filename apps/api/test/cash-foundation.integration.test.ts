import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { DeviceAuthorizationService } from '../src/modules/cash/device-authorization.service.js';
import { DeviceCertificate } from '../src/modules/offline-sync/device-certificate.js';
import { CashOpeningPreparation } from '../src/modules/cash/cash-opening-preparation.js';
import { CashSessionDevicePolicy } from '../src/modules/cash/cash-session-device.policy.js';
import { CashOperationsService } from '../src/modules/cash/cash-operations.service.js';
import { CashCloseService } from '../src/modules/cash/cash-close.service.js';
import { CashDifferenceReviewService } from '../src/modules/cash/cash-difference-review.service.js';
import { ExceptionalClosePreparation } from '../src/modules/cash/exceptional-close-preparation.js';
import { UnrecoverableDeviceService } from '../src/modules/offline-sync/unrecoverable-device.service.js';
import { ExceptionalCashCloseService } from '../src/modules/cash/exceptional-cash-close.service.js';
import { CashWorkspaceService } from '../src/modules/cash/cash-workspace.service.js';

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

  it('T185 provisions a POS key and opaque certificate, with scoped authorization and idempotent replay', async () => {
    const certificate = new DeviceCertificate(randomBytes(32));
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const requestKey = randomUUID();
    const first = await devices.authorizePos(context(ownerId), branchId, publicKey, requestKey, certificate);
    const second = await devices.authorizePos(context(ownerId), branchId, publicKey, requestKey, certificate);
    expect(second).toEqual(first);
    expect(certificate.open(first.certificate)).toMatchObject({ deviceId: first.id,
      organizationId, thumbprint: certificate.thumbprint(publicKey) });
    const row = await admin.query('SELECT public_key, public_key_thumbprint, authorized_at, last_seen_at, last_sync_at FROM devices WHERE id = $1', [first.id]);
    expect(row.rows[0]).toMatchObject({ public_key: publicKey, public_key_thumbprint: certificate.thumbprint(publicKey) });
    expect(row.rows[0]?.authorized_at).toBeInstanceOf(Date);
    expect(row.rows[0]?.last_seen_at).toBeInstanceOf(Date);
    expect(row.rows[0]?.last_sync_at).toBeNull();
    await expect(devices.authorizePos(context(employeeId), branchId, publicKey, randomUUID(), certificate))
      .rejects.toMatchObject({ code: 'DEVICE_AUTHORIZATION_FORBIDDEN' });
    await expect(devices.authorizePos(context(adminId), otherBranchId, publicKey, randomUUID(), certificate))
      .rejects.toMatchObject({ code: 'DEVICE_BRANCH_FORBIDDEN' });
    await expect(devices.authorizePos(context(ownerId), foreignBranchId, publicKey, randomUUID(), certificate))
      .rejects.toMatchObject({ code: 'DEVICE_BRANCH_NOT_AVAILABLE' });
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

  it('T121 keeps the session device while recording the authenticated replacement actor', async () => {
    const registerId = randomUUID();
    const sessionId = randomUUID();
    const device = await devices.authorizeOnline(context(ownerId), branchId);
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, $4)',
      [registerId, organizationId, branchId, 'Actor handoff']);
    await admin.query(`INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id,
      owner_user_id, device_id, origin, status, opening_cash, expected_cash, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', '5.00', '5.00', 'ARS')`,
    [sessionId, organizationId, branchId, registerId, cashierId, device.id]);
    const policy = new CashSessionDevicePolicy();
    await withRuntime(adminId, async (client) => {
      expect(await policy.requireAuthorizedActor(client, context(adminId), sessionId, device.id))
        .toMatchObject({ id: sessionId, deviceId: device.id, actorUserId: adminId });
    });
    await withRuntime(cashierId, async (client) => {
      expect(await policy.requireAuthorizedActor(client, context(cashierId), sessionId, device.id))
        .toMatchObject({ id: sessionId, deviceId: device.id, actorUserId: cashierId });
    });
    await withRuntime(employeeId, async (client) => {
      await expect(policy.requireAuthorizedActor(client, context(employeeId), sessionId, device.id))
        .rejects.toMatchObject({ code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    });
    const row = await admin.query('SELECT owner_user_id, device_id FROM cash_sessions WHERE id = $1', [sessionId]);
    expect(row.rows[0]).toMatchObject({ owner_user_id: cashierId, device_id: device.id });
  });

  it('T121A opens once under concurrent requests and replays the original audited result', async () => {
    const registerId = randomUUID();
    const device = await devices.authorizeOnline(context(ownerId), branchId);
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, $4)',
      [registerId, organizationId, branchId, 'Concurrent opening']);
    const service = new CashOperationsService(new TenantTransaction(runtime));
    const input = { branchId, cashRegisterId: registerId, deviceId: device.id, openingCash: '10.00' };
    const firstContext = context(ownerId);
    const first = await service.open(firstContext, input, 'opening-key');
    expect(first).toMatchObject({ branchId, cashRegisterId: registerId, deviceId: device.id,
      ownerUserId: ownerId, openingCash: '10.00' });
    expect(await service.open(context(ownerId), input, 'opening-key')).toEqual(first);
    await expect(service.open(context(ownerId), { ...input, openingCash: '11.00' }, 'opening-key'))
      .rejects.toMatchObject({ name: 'IdempotencyKeyReusedError' });
    const otherRegister = randomUUID();
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, $4)',
      [otherRegister, organizationId, branchId, 'Racing opening']);
    const racingInput = { ...input, cashRegisterId: otherRegister };
    const outcomes = await Promise.allSettled([
      service.open(context(ownerId), racingInput, 'race-a'),
      service.open(context(ownerId), racingInput, 'race-b'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect((await admin.query('SELECT id FROM cash_sessions WHERE cash_register_id = $1', [otherRegister])).rowCount).toBe(1);
    const audit = await admin.query('SELECT actor_user_id, device_id FROM audit_events WHERE entity_id = $1', [first.id]);
    expect(audit.rows).toEqual([{ actor_user_id: ownerId, device_id: device.id }]);
    await expect(service.open({ organizationId: foreignOrganizationId, userId: ownerId,
      requestId: randomUUID() }, input, 'foreign-opening'))
      .rejects.toMatchObject({ code: 'CASH_OPENING_FORBIDDEN' });
  });

  it('T122 records a positive manual deposit with reason, real actor and one atomic effect', async () => {
    const registerId = randomUUID();
    const device = await devices.authorizeOnline(context(ownerId), branchId);
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, $4)',
      [registerId, organizationId, branchId, 'Manual deposit']);
    const service = new CashOperationsService(new TenantTransaction(runtime));
    const session = await service.open(context(cashierId), { branchId, cashRegisterId: registerId,
      deviceId: device.id, openingCash: '2.00' }, randomUUID());
    const input = { cashSessionId: session.id, deviceId: device.id, amount: '3.50', reason: 'Cambio' };
    const deposit = await service.deposit(context(adminId), input, 'deposit-key');
    expect(deposit).toMatchObject({ cashSessionId: session.id, actorUserId: adminId,
      deviceId: device.id, amount: '3.50', expectedCash: '5.50' });
    expect(await service.deposit(context(adminId), input, 'deposit-key')).toEqual(deposit);
    await expect(service.deposit(context(adminId), { ...input, amount: '4.00' }, 'deposit-key'))
      .rejects.toMatchObject({ name: 'IdempotencyKeyReusedError' });
    await expect(service.deposit(context(employeeId), input, 'employee-key'))
      .rejects.toMatchObject({ code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    const movement = await admin.query('SELECT actor_user_id, device_id, delta, reason FROM cash_movements WHERE id = $1',
      [deposit.id]);
    expect(movement.rows).toEqual([{ actor_user_id: adminId, device_id: device.id,
      delta: '3.50', reason: 'Cambio' }]);
    expect((await admin.query('SELECT expected_cash FROM cash_sessions WHERE id = $1', [session.id]))
      .rows[0]?.expected_cash).toBe('5.50');
    expect((await admin.query('SELECT actor_user_id FROM audit_events WHERE entity_id = $1', [deposit.id]))
      .rows[0]?.actor_user_id).toBe(adminId);
    await admin.query(`INSERT INTO cash_session_state_transitions
      (id, organization_id, cash_session_id, actor_user_id, from_status, to_status)
      VALUES ($1, $2, $3, $4, 'OPEN', 'CLOSING')`,
    [randomUUID(), organizationId, session.id, cashierId]);
    expect(await service.deposit(context(adminId), input, 'deposit-key')).toEqual(deposit);
  });

  it('T123 rejects an excessive withdrawal completely after the session lock', async () => {
    const registerId = randomUUID();
    const device = await devices.authorizeOnline(context(ownerId), branchId);
    const otherDevice = await devices.authorizeOnline(context(ownerId), branchId);
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, $4)',
      [registerId, organizationId, branchId, 'Manual withdrawal']);
    const service = new CashOperationsService(new TenantTransaction(runtime));
    const session = await service.open(context(cashierId), { branchId, cashRegisterId: registerId,
      deviceId: device.id, openingCash: '5.00' }, randomUUID());
    const input = { cashSessionId: session.id, deviceId: device.id, amount: '3.00', reason: 'Retiro' };
    await expect(service.withdraw(context(ownerId), { ...input, deviceId: otherDevice.id }, randomUUID()))
      .rejects.toMatchObject({ code: 'CASH_SESSION_DEVICE_CONFLICT' });
    const outcomes = await Promise.allSettled([
      service.withdraw(context(ownerId), input, 'withdraw-a'),
      service.withdraw(context(ownerId), input, 'withdraw-b'),
    ]);
    const successes = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'CASH_INSUFFICIENT_EXPECTED' });
    const result = (successes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof service.withdraw>>>).value;
    expect(result).toMatchObject({ amount: '3.00', expectedCash: '2.00' });
    expect(await service.withdraw(context(ownerId), input,
      outcomes[0]?.status === 'fulfilled' ? 'withdraw-a' : 'withdraw-b')).toEqual(result);
    expect((await admin.query('SELECT id FROM cash_movements WHERE cash_session_id = $1', [session.id])).rowCount).toBe(1);
    expect((await admin.query('SELECT id FROM audit_events WHERE entity_id = $1', [result.id])).rowCount).toBe(1);
    expect((await admin.query('SELECT expected_cash FROM cash_sessions WHERE id = $1', [session.id]))
      .rows[0]?.expected_cash).toBe('2.00');
  });

  it('T124 calculates expected cash from the consolidated server ledger', async () => {
    const registerId = randomUUID();
    const signer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const device = await devices.authorizePos(context(ownerId), branchId,
      signer.publicKey.export({ format: 'pem', type: 'spki' }).toString(), randomUUID(), new DeviceCertificate(randomBytes(32)));
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, $4)',
      [registerId, organizationId, branchId, 'Expected cash']);
    const service = new CashOperationsService(new TenantTransaction(runtime));
    const session = await service.open(context(ownerId), { branchId, cashRegisterId: registerId,
      deviceId: device.id, openingCash: '8.25' }, randomUUID());
    await service.deposit(context(ownerId), { cashSessionId: session.id, deviceId: device.id,
      amount: '2.50', reason: 'Cambio' }, randomUUID());
    await service.withdraw(context(ownerId), { cashSessionId: session.id, deviceId: device.id,
      amount: '1.10', reason: 'Retiro' }, randomUUID());
    await admin.query(`INSERT INTO cash_movements (id, organization_id, branch_id, cash_session_id,
      actor_user_id, device_id, delta, currency_code, source_type, source_id, effect_kind)
      VALUES ($1, $2, $3, $4, $5, $6, '4.00', 'ARS', 'SALE', $7, 'IN')`,
    [randomUUID(), organizationId, branchId, session.id, ownerId, device.id, randomUUID()]);
    for (const [source, delta] of [['SALE_CANCELLATION', '-0.60'], ['EXPENSE', '-1.20'], ['PURCHASE_PAYMENT', '-0.90']]) {
      await admin.query(`INSERT INTO cash_movements (id,organization_id,branch_id,cash_session_id,
        actor_user_id,device_id,delta,currency_code,source_type,source_id,effect_kind)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'ARS',$8,$9,'OUT')`,
      [randomUUID(), organizationId, branchId, session.id, ownerId, device.id, delta, source, randomUUID()]);
    }
    expect(await service.calculateExpectedCash(context(ownerId), session.id, device.id))
      .toMatchObject({ cashSessionId: session.id, expectedCash: '10.95' });
    await expect(service.calculateExpectedCash(context(adminId), session.id, randomUUID()))
      .rejects.toMatchObject({ code: 'CASH_SESSION_DEVICE_CONFLICT' });
    const close = new CashCloseService(new TenantTransaction(runtime));
    const checkpoint = { version: 1 as const, organizationId, deviceId: device.id, actorUserId: ownerId,
      sessionId: session.id, sequence: '0', headHash: '0'.repeat(64), sessionSequence: '0', creationFrozen: true as const, pending: 0 as const };
    const signature = sign('sha256', Buffer.from(JSON.stringify(checkpoint)),
      { key: signer.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    const attempt = await close.begin(context(ownerId), { checkpoint, signature }, randomUUID());
    const input = { cashSessionId: session.id, deviceId: device.id, closeAttemptId: attempt.closeAttemptId };
    expect(await close.finalSync(context(ownerId), input, randomUUID())).toMatchObject({ expectedCash: '10.95' });
    expect(await close.close(context(ownerId), { ...input, expectedCash: '10.95', countedCash: '10.95', reason: '' }, randomUUID()))
      .toMatchObject({ status: 'CLOSED', expectedCash: '10.95', countedCash: '10.95', difference: '0.00' });
  });

  it('T214B begins close with a signed complete checkpoint, rejects forgery and replays once', async () => {
    const signer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const device = await devices.authorizePos(context(ownerId), branchId,
      signer.publicKey.export({ format: 'pem', type: 'spki' }).toString(), randomUUID(), new DeviceCertificate(randomBytes(32)));
    const registerId = randomUUID();
    await admin.query('INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1,$2,$3,$4)',
      [registerId, organizationId, branchId, 'Close protocol']);
    const cash = new CashOperationsService(new TenantTransaction(runtime));
    const session = await cash.open(context(ownerId), { branchId, cashRegisterId: registerId, deviceId: device.id, openingCash: '8.25' }, randomUUID());
    const checkpoint = { version: 1 as const, organizationId, deviceId: device.id, actorUserId: ownerId,
      sessionId: session.id, sequence: '0', headHash: '0'.repeat(64), sessionSequence: '0', creationFrozen: true as const, pending: 0 as const };
    const signature = sign('sha256', Buffer.from(JSON.stringify(checkpoint)), { key: signer.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    const service = new CashCloseService(new TenantTransaction(runtime));
    const input = { checkpoint, signature };
    await expect(service.begin(context(ownerId), { ...input, signature: Buffer.alloc(64).toString('base64') }, randomUUID()))
      .rejects.toThrow('CASH_CHECKPOINT_INVALID');
    await expect(service.begin(context(employeeId), input, randomUUID())).rejects.toThrow();
    await expect(service.begin({ ...context(ownerId), organizationId: foreignOrganizationId }, input, randomUUID())).rejects.toThrow();
    const key = randomUUID();
    const result = await service.begin(context(ownerId), input, key);
    expect(result).toMatchObject({ cashSessionId: session.id, status: 'CLOSING' });
    await expect(cash.open(context(ownerId), { branchId, cashRegisterId: registerId,
      deviceId: device.id, openingCash: '0.00' }, randomUUID())).rejects.toThrow();
    expect((await admin.query("SELECT count(*)::integer AS count FROM cash_sessions WHERE cash_register_id=$1 AND status IN ('OPEN','CLOSING')",
      [registerId])).rows[0]?.count).toBe(1);
    expect(await service.begin(context(ownerId), input, key)).toEqual(result);
    const closingWorkspace=await new CashWorkspaceService(new TenantTransaction(runtime)).read(context(ownerId),branchId);
    expect(closingWorkspace.sessions.find(row=>row.id===session.id)).toMatchObject({closeAttemptId:result.closeAttemptId,
      chain:{sequence:'0',headHash:'0'.repeat(64),sessionSequence:'0'},finalSync:null});
    await expect(cash.deposit(context(ownerId), { cashSessionId: session.id, deviceId: device.id, amount: '1.00', reason: 'Late' }, randomUUID()))
      .rejects.toMatchObject({ code: 'CASH_SESSION_NOT_OPEN' });
    expect((await admin.query('SELECT count(*)::integer AS count FROM cash_close_attempts WHERE cash_session_id=$1', [session.id])).rows[0]?.count).toBe(1);
    const syncKey = randomUUID();
    const final = await service.finalSync(context(ownerId), { cashSessionId: session.id, deviceId: device.id, closeAttemptId: result.closeAttemptId }, syncKey);
    expect(final).toMatchObject({ cashSessionId: session.id, closeAttemptId: result.closeAttemptId, expectedCash: '8.25', ready: true });
    expect(await service.finalSync(context(ownerId), { cashSessionId: session.id, deviceId: device.id, closeAttemptId: result.closeAttemptId }, syncKey)).toEqual(final);
    expect((await new CashWorkspaceService(new TenantTransaction(runtime)).read(context(ownerId),branchId)).sessions.find(row=>row.id===session.id))
      .toMatchObject({finalSync:{ready:true,expectedCash:'8.25'}});
    await expect(service.finalSync(context(ownerId), { cashSessionId: session.id, deviceId: device.id, closeAttemptId: randomUUID() }, randomUUID()))
      .rejects.toThrow('CASH_CLOSE_STATE_INVALID');
    const closeInput = { cashSessionId: session.id, deviceId: device.id, closeAttemptId: result.closeAttemptId,
      expectedCash: final.expectedCash, countedCash: '9.25', reason: 'Sobrante contado' };
    await expect(service.close(context(ownerId), { ...closeInput, countedCash: '-1.00' }, randomUUID())).rejects.toThrow();
    await expect(service.close(context(ownerId), { ...closeInput, reason: '' }, randomUUID())).rejects.toThrow();
    const closeKey = randomUUID();
    await admin.query(`CREATE FUNCTION reject_close_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='cash.session.closed' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_close_audit_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_close_audit_test()`);
    try {
      await expect(service.close(context(ownerId), closeInput, closeKey)).rejects.toThrow('audit unavailable');
      expect((await admin.query('SELECT status FROM cash_sessions WHERE id=$1', [session.id])).rows[0]?.status).toBe('CLOSING');
      expect((await admin.query('SELECT count(*)::integer AS count FROM cash_session_closures WHERE cash_session_id=$1', [session.id])).rows[0]?.count).toBe(0);
    } finally {
      await admin.query('DROP TRIGGER reject_close_audit_test ON audit_events; DROP FUNCTION reject_close_audit_test()');
    }
    const closed = await service.close(context(ownerId), closeInput, closeKey);
    expect(closed).toMatchObject({ status: 'CLOSED', expectedCash: '8.25', countedCash: '9.25', difference: '1.00' });
    expect(await service.close(context(ownerId), closeInput, closeKey)).toEqual(closed);
    const pendingDifference=(await new CashWorkspaceService(new TenantTransaction(runtime)).read(context(ownerId),branchId,{view:'PENDING_REVIEW'}))
      .sessions.find(row=>row.id===session.id);
    expect(pendingDifference).toMatchObject({status:'CLOSED',closure:{expectedCash:'8.25',countedCash:'9.25',difference:'1.00'},
      differenceReview:{status:'PENDING_REVIEW',selfReview:true,canReview:false}});
    expect((await admin.query('SELECT count(*)::integer AS count FROM cash_difference_reviews WHERE cash_session_id=$1', [session.id])).rows[0]?.count).toBe(1);
    await expect(admin.query('UPDATE cash_session_closures SET counted_cash=counted_cash+1 WHERE cash_session_id=$1', [session.id])).rejects.toThrow('immutable');
    const reviewId = (await admin.query<{ id: string }>('SELECT id FROM cash_difference_reviews WHERE cash_session_id=$1', [session.id])).rows[0]?.id;
    if (!reviewId) throw new Error('Missing difference review');
    const reviews = new CashDifferenceReviewService(new TenantTransaction(runtime));
    await expect(reviews.review(context(ownerId), reviewId, 'Revisado por mí', randomUUID())).rejects.toThrow('CASH_SELF_REVIEW_FORBIDDEN');
    await expect(reviews.review(context(employeeId), reviewId, '', randomUUID())).rejects.toThrow();
    await expect(reviews.review({ ...context(ownerId), organizationId: foreignOrganizationId }, reviewId, '', randomUUID())).rejects.toThrow();
    const reviewKey = randomUUID();
    const closureBefore = (await admin.query('SELECT * FROM cash_session_closures WHERE cash_session_id=$1', [session.id])).rows;
    const reviewStartedAt = (await admin.query<{ timestamp: Date }>(
      'SELECT clock_timestamp() AS timestamp')).rows[0]?.timestamp;
    if (!reviewStartedAt) throw new Error('Missing database clock');
    const reviewed = await reviews.review(context(adminId), reviewId, 'Revisado', reviewKey);
    expect(reviewed).toMatchObject({ id: reviewId, status: 'REVIEWED', mode: 'REVIEW', reviewerUserId: adminId });
    expect(await reviews.review(context(adminId), reviewId, 'Revisado', reviewKey)).toEqual(reviewed);
    expect((await admin.query('SELECT * FROM cash_session_closures WHERE cash_session_id=$1', [session.id])).rows).toEqual(closureBefore);
    const reviewEvent = (await admin.query<{ reviewer_user_id: string; reviewed_at: Date; observed_at: Date }>(
      'SELECT reviewer_user_id,reviewed_at,clock_timestamp() AS observed_at FROM cash_difference_review_events WHERE review_id=$1', [reviewId])).rows[0];
    if (!reviewEvent) throw new Error('Missing difference review event');
    expect(reviewEvent?.reviewer_user_id).toBe(adminId);
    expect(reviewEvent?.reviewed_at.getTime()).toBeGreaterThanOrEqual(reviewStartedAt.getTime());
    expect(reviewEvent.reviewed_at.getTime()).toBeLessThanOrEqual(reviewEvent.observed_at.getTime());
    expect(reviewed.reviewedAt).toBe(reviewEvent.reviewed_at.toISOString());
    expect((await admin.query('SELECT expected_cash,counted_cash,difference FROM cash_session_closures WHERE cash_session_id=$1', [session.id])).rows[0])
      .toMatchObject({ expected_cash: '8.25', counted_cash: '9.25', difference: '1.00' });
    await expect(service.abort(context(ownerId), { cashSessionId: session.id, deviceId: device.id, closeAttemptId: result.closeAttemptId }, randomUUID()))
      .rejects.toThrow('CASH_CLOSE_STATE_INVALID');
    const next = await cash.open(context(ownerId), { branchId, cashRegisterId: registerId, deviceId: device.id, openingCash: '0.00' }, randomUUID());
    const correction = await cash.deposit(context(ownerId), { cashSessionId: next.id, deviceId: device.id,
      amount: '1.00', reason: `Corrección de diferencia revisada ${reviewId}` }, randomUUID());
    expect((await admin.query('SELECT cash_session_id,delta::text AS delta,reason FROM cash_movements WHERE id=$1', [correction.id])).rows[0])
      .toEqual({ cash_session_id: next.id, delta: '1.00', reason: `Corrección de diferencia revisada ${reviewId}` });
    expect((await admin.query('SELECT * FROM cash_session_closures WHERE cash_session_id=$1', [session.id])).rows).toEqual(closureBefore);
    const nextCheckpoint = { ...checkpoint, sessionId: next.id };
    const nextInput = { checkpoint: nextCheckpoint,
      signature: sign('sha256', Buffer.from(JSON.stringify(nextCheckpoint)), { key: signer.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') };
    const attempt = await service.begin(context(ownerId), nextInput, randomUUID());
    const oldInput = { cashSessionId: next.id, deviceId: device.id, closeAttemptId: attempt.closeAttemptId };
    await service.finalSync(context(ownerId), oldInput, randomUUID());
    const abortKey = randomUUID();
    expect(await service.abort(context(ownerId), oldInput, abortKey)).toMatchObject({ status: 'OPEN' });
    expect(await service.abort(context(ownerId), oldInput, abortKey)).toMatchObject({ status: 'OPEN' });
    expect((await new CashWorkspaceService(new TenantTransaction(runtime)).read(context(ownerId),branchId)).sessions.find(row=>row.id===next.id))
      .toMatchObject({status:'OPEN',closeAttemptId:null,finalSync:null,lastAbortedAttemptId:attempt.closeAttemptId});
    const renewed = await service.begin(context(ownerId), nextInput, randomUUID());
    expect(renewed.closeAttemptId).not.toBe(attempt.closeAttemptId);
    await expect(service.close(context(ownerId), { ...oldInput, expectedCash: '0.00', countedCash: '0.00', reason: '' }, randomUUID()))
      .rejects.toThrow('CASH_CLOSE_STATE_INVALID');
    await service.finalSync(context(ownerId), { ...oldInput, closeAttemptId: renewed.closeAttemptId }, randomUUID());
    await service.close(context(ownerId), { ...oldInput, closeAttemptId: renewed.closeAttemptId, expectedCash: '1.00', countedCash: '1.00', reason: '' }, randomUUID());
    expect((await admin.query('SELECT count(*)::integer AS count FROM cash_difference_reviews WHERE cash_session_id=$1', [next.id])).rows[0]?.count).toBe(0);
    const selfSession = await cash.open(context(ownerId), { branchId, cashRegisterId: registerId, deviceId: device.id, openingCash: '0.00' }, randomUUID());
    const selfCheckpoint = { ...checkpoint, sessionId: selfSession.id };
    const selfAttempt = await service.begin(context(ownerId), { checkpoint: selfCheckpoint,
      signature: sign('sha256', Buffer.from(JSON.stringify(selfCheckpoint)), { key: signer.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') }, randomUUID());
    const selfInput = { cashSessionId: selfSession.id, deviceId: device.id, closeAttemptId: selfAttempt.closeAttemptId };
    await service.finalSync(context(ownerId), selfInput, randomUUID());
    await service.close(context(ownerId), { ...selfInput, expectedCash: '0.00', countedCash: '1.00', reason: 'Diferencia' }, randomUUID());
    const selfReview = (await admin.query<{id:string}>('SELECT id FROM cash_difference_reviews WHERE cash_session_id=$1',[selfSession.id])).rows[0]?.id;
    if (!selfReview) throw new Error('Missing self review');
    await admin.query("UPDATE memberships SET status='REVOKED',revoked_at=now() WHERE organization_id=$1 AND user_id=$2",[organizationId,adminId]);
    try {
      await expect(reviews.review(context(ownerId),selfReview,'',randomUUID())).rejects.toThrow('justificación');
      expect(await reviews.review(context(ownerId),selfReview,'No hay otro revisor activo con alcance',randomUUID()))
        .toMatchObject({status:'REVIEWED',mode:'SELF_REVIEW'});
    } finally {
      await admin.query("UPDATE memberships SET status='ACTIVE',revoked_at=NULL WHERE organization_id=$1 AND user_id=$2",[organizationId,adminId]);
    }
    const blocker = await cash.open(context(ownerId), { branchId, cashRegisterId: registerId, deviceId: device.id, openingCash: '2.00' }, randomUUID());
    const conflictedId = randomUUID();
    await admin.query(`INSERT INTO cash_sessions (id,organization_id,branch_id,cash_register_id,owner_user_id,device_id,
      origin,status,opening_cash,expected_cash,currency_code) VALUES ($1,$2,$3,$4,$5,$6,'OFFLINE','CONFLICTED','3.00','3.00','ARS')`,
    [conflictedId,organizationId,branchId,registerId,ownerId,device.id]);
    const conflictCheckpoint = { ...checkpoint,sessionId:conflictedId };
    const conflictInput = { checkpoint:conflictCheckpoint,
      signature:sign('sha256',Buffer.from(JSON.stringify(conflictCheckpoint)),{key:signer.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64'),
      countedCash:'4.00',reason:'Operaciones conciliadas por separado' };
    await expect(service.begin(context(ownerId),{checkpoint:conflictCheckpoint,signature:conflictInput.signature},randomUUID()))
      .rejects.toMatchObject({code:'CASH_SESSION_NOT_OPEN'});
    await expect(service.reconcile(context(cashierId),conflictInput,randomUUID())).rejects.toThrow();
    await expect(service.reconcile(context(ownerId),{...conflictInput,reason:''},randomUUID())).rejects.toThrow();
    const reconcileKey = randomUUID();
    expect(await service.reconcile(context(ownerId),conflictInput,reconcileKey)).toMatchObject({cashSessionId:conflictedId,status:'CLOSED_CONFLICT_RESOLVED',difference:'1.00'});
    expect(await service.reconcile(context(ownerId),conflictInput,reconcileKey)).toMatchObject({status:'CLOSED_CONFLICT_RESOLVED'});
    expect((await admin.query('SELECT status,expected_cash FROM cash_sessions WHERE id=$1',[blocker.id])).rows[0])
      .toMatchObject({status:'OPEN',expected_cash:'2.00'});
    const raceCheckpoint={...checkpoint,sessionId:blocker.id};
    const raceInput={checkpoint:raceCheckpoint,signature:sign('sha256',Buffer.from(JSON.stringify(raceCheckpoint)),
      {key:signer.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')};
    const raceKey=randomUUID();
    const race=await Promise.allSettled([
      service.begin(context(ownerId),raceInput,raceKey),
      cash.deposit(context(ownerId),{cashSessionId:blocker.id,deviceId:device.id,amount:'1.00',reason:'Concurrente'},randomUUID()),
    ]);
    const started=race[0];
    if (started?.status!=='fulfilled') throw new Error('Begin-close lost the concurrency race');
    // Recover after a simulated lost response/crash with the same immutable request.
    expect(await service.begin(context(ownerId),raceInput,raceKey)).toEqual(started.value);
    const consolidated=await service.finalSync(context(ownerId),{cashSessionId:blocker.id,deviceId:device.id,closeAttemptId:started.value.closeAttemptId},randomUUID());
    expect(consolidated.expectedCash).toBe(race[1]?.status==='fulfilled' ? '3.00':'2.00');
    if (race[1]?.status==='rejected') expect(race[1].reason).toMatchObject({code:'CASH_SESSION_NOT_OPEN'});
    await new UnrecoverableDeviceService(new TenantTransaction(runtime)).declare(context(ownerId),device.id);
    const preparation=new ExceptionalClosePreparation();
    const prepare=(userId:string,confirm:boolean,reason:string)=>new TenantTransaction(runtime).runWithOptionalAudit(context(userId),async client=>({
      result:await preparation.prepare(client,context(userId),{cashSessionId:blocker.id,confirm,reason}),
    }));
    await expect(prepare(ownerId,false,'Irrecuperable')).rejects.toThrow();
    await expect(prepare(ownerId,true,'')).rejects.toThrow();
    await expect(prepare(cashierId,true,'Irrecuperable')).rejects.toThrow();
    expect(await prepare(adminId,true,'Dispositivo extraviado y sin posibilidad de recuperar pendientes'))
      .toMatchObject({cashSessionId:blocker.id,status:'CLOSING',deviceId:device.id,branchId});
    const snapshot=await new TenantTransaction(runtime).runWithOptionalAudit(context(ownerId),async client=>{
      const prepared=await preparation.prepare(client,context(ownerId),{cashSessionId:blocker.id,confirm:true,reason:'Dispositivo perdido'});
      return {result:await preparation.snapshot(client,context(ownerId),prepared)};
    });
    expect(snapshot).toMatchObject({version:1,deviceId:device.id,operationalDataCompleteness:'UNKNOWN',
      expectedCashKnown:consolidated.expectedCash,countedCash:null,differenceObserved:null,lateData:'NONE',operationsReceived:[]});
    expect((await admin.query('SELECT status,expected_cash FROM cash_sessions WHERE id=$1',[blocker.id])).rows[0])
      .toMatchObject({status:'CLOSING',expected_cash:consolidated.expectedCash});
    const exceptional=new ExceptionalCashCloseService(new TenantTransaction(runtime));
    const exceptionalInput={cashSessionId:blocker.id,confirm:true as const,reason:'Dispositivo perdido'};
    await expect(exceptional.close(context(cashierId),exceptionalInput,randomUUID())).rejects.toThrow();
    await expect(exceptional.close({...context(ownerId),organizationId:foreignOrganizationId},exceptionalInput,randomUUID())).rejects.toThrow();
    const exceptionalKey=randomUUID();
    const exceptionalResult=await exceptional.close(context(adminId),exceptionalInput,exceptionalKey);
    expect(exceptionalResult).toMatchObject({cashSessionId:blocker.id,status:'CLOSED_WITH_UNRECOVERED_DEVICE'});
    expect(await exceptional.close(context(adminId),exceptionalInput,exceptionalKey)).toEqual(exceptionalResult);
    expect((await admin.query('SELECT status,completeness,expected_cash FROM cash_sessions WHERE id=$1',[blocker.id])).rows[0])
      .toMatchObject({status:'CLOSED_WITH_UNRECOVERED_DEVICE',completeness:'UNKNOWN',expected_cash:consolidated.expectedCash});
    await expect(admin.query("UPDATE cash_exceptional_closures SET snapshot='{}' WHERE cash_session_id=$1",[blocker.id])).rejects.toThrow('immutable');
    const replacement=await devices.authorizeOnline(context(ownerId),branchId);
    expect(await cash.open(context(ownerId),{branchId,cashRegisterId:registerId,deviceId:replacement.id,openingCash:'0.00'},randomUUID()))
      .toMatchObject({deviceId:replacement.id});
  });

  it('T218A reads an explicit cash projection under runtime RLS, branch scope and cashier ownership',async()=>{
    const workspace=new CashWorkspaceService(new TenantTransaction(runtime));
    const cash=new CashOperationsService(new TenantTransaction(runtime));
    const registerId=randomUUID();
    await admin.query("INSERT INTO cash_registers(id,organization_id,branch_id,name) VALUES($1,$2,$3,'UI scope')",
      [registerId,organizationId,branchId]);
    const device=await devices.authorizeOnline(context(ownerId),branchId);
    const opened=await cash.open(context(cashierId),{branchId,cashRegisterId:registerId,deviceId:device.id,openingCash:'3.00'},randomUUID());
    expect((await workspace.read(context(cashierId),branchId)).sessions.map(row=>row.id)).toContain(opened.id);
    const cashierRows=await admin.query<{id:string}>('SELECT id FROM cash_sessions WHERE organization_id=$1 AND branch_id=$2 AND owner_user_id=$3 AND status IN (\'OPEN\',\'CLOSING\',\'CONFLICTED\')',
      [organizationId,branchId,cashierId]);
    expect(new Set((await workspace.read(context(cashierId),branchId)).sessions.map(row=>row.id)))
      .toEqual(new Set(cashierRows.rows.map(row=>row.id)));
    expect((await workspace.read(context(adminId),branchId)).sessions.map(row=>row.id)).toContain(opened.id);
    expect((await workspace.read(context(cashierId),branchId,{sessionId:opened.id})).sessions.map(row=>row.id)).toEqual([opened.id]);
    expect((await workspace.read(context(cashierId),branchId,{sessionId:randomUUID()})).sessions).toEqual([]);
    const firstPage=await workspace.read(context(ownerId),branchId,{limit:1});
    expect(firstPage.sessions).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTypeOf('string');
    if(!firstPage.nextCursor)throw new Error('Expected next cursor');
    const secondPage=await workspace.read(context(ownerId),branchId,{limit:1,cursor:firstPage.nextCursor});
    expect(secondPage.sessions).toHaveLength(1);
    expect(secondPage.sessions[0]?.id).not.toBe(firstPage.sessions[0]?.id);
    expect(firstPage.sessions[0]).not.toHaveProperty('cursorTime');
    await expect(workspace.read(context(adminId),otherBranchId)).rejects.toMatchObject({code:'CASH_SESSION_ACTOR_FORBIDDEN'});
    await expect(workspace.read(context(employeeId),branchId)).rejects.toMatchObject({code:'CASH_SESSION_ACTOR_FORBIDDEN'});
    await expect(workspace.read(context(ownerId),foreignBranchId)).rejects.toMatchObject({code:'CASH_SESSION_ACTOR_FORBIDDEN'});
    await expect(workspace.read({...context(ownerId),organizationId:foreignOrganizationId},branchId))
      .rejects.toMatchObject({code:'CASH_SESSION_ACTOR_FORBIDDEN'});
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
