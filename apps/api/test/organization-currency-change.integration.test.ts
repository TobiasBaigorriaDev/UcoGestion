import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { ConfigurationBarrierService } from '../src/modules/offline-sync/configuration-barrier.service.js';
import { ConfigurationVersionService } from '../src/modules/offline-sync/configuration-version.service.js';
import { UnrecoverableDeviceService } from '../src/modules/offline-sync/unrecoverable-device.service.js';
import { OrganizationCurrencyChangeService } from '../src/modules/organizations/organization-currency-change.service.js';

describe('organization currency change', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let service: OrganizationCurrencyChangeService;
  let versions: ConfigurationVersionService;
  let barriers: ConfigurationBarrierService;
  let unrecoverableDevices: UnrecoverableDeviceService;
  let organizationId: string;
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const context = (requestId: string, userId = ownerId) => ({ organizationId, requestId, userId });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE ROLE uco_currency_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri());
    url.username = 'uco_currency_runtime';
    url.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: url.toString() });
    const transactions = new TenantTransaction(runtimePool);
    service = new OrganizationCurrencyChangeService(transactions);
    barriers = new ConfigurationBarrierService(transactions);
    unrecoverableDevices = new UnrecoverableDeviceService(transactions);
    versions = new ConfigurationVersionService(transactions, {
      keyId: 'currency-test-key', publicKeyPem,
      sign(payload) {
        const signer = createSign('SHA256');
        signer.update(payload);
        signer.end();
        return signer.sign(privateKey).toString('base64');
      },
    });
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
       VALUES ($1, 'currency-owner@example.com', '$argon2id$v=19$owner', 1),
              ($2, 'currency-admin@example.com', '$argon2id$v=19$admin', 1)`,
      [ownerId, adminId],
    );
  });

  beforeEach(async () => {
    organizationId = randomUUID();
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone)
       VALUES ($1, 'Currency tenant', 'ARS', 'America/Argentina/Mendoza')`, [organizationId],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role)
       VALUES ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'ADMIN')`,
      [randomUUID(), organizationId, ownerId, randomUUID(), adminId],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('changes currency once for OWNER and replays the same idempotency key without duplicate audit', async () => {
    const first = await service.change(context('currency-first'), 1, 'usd', 'currency-key-1');
    expect(first).toEqual({ currency: 'USD', version: 2 });
    expect(await service.change(context('currency-retry'), 1, 'USD', 'currency-key-1')).toEqual(first);
    expect((await pool.query(
      "SELECT count(*)::integer AS count FROM audit_events WHERE organization_id = $1 AND action = 'organization.currency_changed'",
      [organizationId],
    )).rows[0]?.count).toBe(1);
    await expect(service.change(context('currency-different-payload'), 1, 'EUR', 'currency-key-1'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('rejects ADMIN and any confirmed history without changing currency', async () => {
    await expect(service.change(context('currency-admin', adminId), 1, 'USD', 'currency-admin-key'))
      .rejects.toMatchObject({ code: 'CURRENCY_CHANGE_FORBIDDEN' });
    await pool.query(
      `INSERT INTO organization_history_references
         (id, organization_id, reference_domain, reference_type, source_id)
       VALUES ($1, $2, 'INVENTORY', 'ADJUSTMENT', $3)`,
      [randomUUID(), organizationId, randomUUID()],
    );
    await expect(service.change(context('currency-history'), 1, 'USD', 'currency-history-key'))
      .rejects.toMatchObject({ code: 'CURRENCY_LOCKED_BY_HISTORY' });
    expect((await pool.query('SELECT base_currency FROM organizations WHERE id = $1',
      [organizationId])).rows[0]?.base_currency).toBe('ARS');
  });

  it('serializes grant issuance against the currency change and rejects old signed configuration', async () => {
    const deviceId = randomUUID();
    await pool.query(
      `INSERT INTO devices (id, organization_id, status, public_key)
       VALUES ($1, $2, 'ACTIVE', $3)`, [deviceId, organizationId, publicKeyPem],
    );
    const configuration = await versions.issue(context('currency-race-config'));
    const attempts = await Promise.allSettled([
      service.change(context('currency-race-change'), 1, 'USD', 'currency-race-key'),
      barriers.issueGrant(context('currency-race-grant'), deviceId, configuration.version),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    const current = (await pool.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1', [organizationId],
    )).rows[0]?.base_currency;
    const activeGrantCount = (await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM offline_grants WHERE organization_id = $1',
      [organizationId],
    )).rows[0]?.count;
    expect([current, activeGrantCount]).toEqual(current === 'USD' ? ['USD', 0] : ['ARS', 1]);
  });

  it('rolls back the currency and idempotency record if audit persistence fails', async () => {
    await pool.query(`CREATE FUNCTION reject_currency_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'organization.currency_changed' THEN
          RAISE EXCEPTION 'audit unavailable';
        END IF;
        RETURN NEW;
      END;
    $$`);
    await pool.query(`CREATE TRIGGER reject_currency_audit_trigger
      BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_currency_audit()`);
    try {
      await expect(service.change(context('currency-audit-rollback'), 1, 'USD', 'currency-rollback-key'))
        .rejects.toThrow('audit unavailable');
      const state = await pool.query<{ base_currency: string; version: number }>(
        'SELECT base_currency, version::integer AS version FROM organizations WHERE id = $1',
        [organizationId],
      );
      expect(state.rows[0]).toMatchObject({ base_currency: 'ARS', version: 1 });
      const idempotency = await pool.query(
        "SELECT 1 FROM idempotency_records WHERE organization_id = $1 AND key = 'currency-rollback-key'",
        [organizationId],
      );
      expect(idempotency.rowCount).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER reject_currency_audit_trigger ON audit_events');
      await pool.query('DROP FUNCTION reject_currency_audit()');
    }
  });

  it('waits for a concurrent first historical reference before deciding whether currency can change', async () => {
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO organization_history_references
           (id, organization_id, reference_domain, reference_type, source_id)
         VALUES ($1, $2, 'COMMERCIAL', 'FIRST_OPERATION', $3)`,
        [randomUUID(), organizationId, randomUUID()],
      );
      const attemptedChange = service.change(context('currency-after-first-operation'), 1, 'USD',
        'currency-after-first-operation-key');
      await writer.query('COMMIT');
      await expect(attemptedChange).rejects.toMatchObject({ code: 'CURRENCY_LOCKED_BY_HISTORY' });
      expect((await pool.query('SELECT base_currency FROM organizations WHERE id = $1',
        [organizationId])).rows[0]?.base_currency).toBe('ARS');
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });

  it('rejects a direct old-currency grant after the currency change', async () => {
    const deviceId = randomUUID();
    await pool.query(
      `INSERT INTO devices (id, organization_id, status, public_key)
       VALUES ($1, $2, 'ACTIVE', $3)`, [deviceId, organizationId, publicKeyPem],
    );
    const oldConfiguration = await versions.issue(context('currency-old-config'));
    await service.change(context('currency-before-old-grant'), 1, 'USD', 'currency-before-old-grant-key');
    await expect(pool.query(
      `INSERT INTO offline_grants
         (id, organization_id, device_id, epoch, configuration_version, expires_at)
       VALUES ($1, $2, $3, 1, $4, now() + interval '72 hours')`,
      [randomUUID(), organizationId, deviceId, oldConfiguration.version],
    )).rejects.toThrow('grant issuance blocked');
  });

  it('guards direct currency updates at the database boundary', async () => {
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [adminId]);
      await expect(client.query(
        "UPDATE organizations SET base_currency = 'USD', version = version + 1 WHERE id = $1",
        [organizationId],
      )).rejects.toThrow('actor is not OWNER');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('blocks uncertain currency, then permits it after a complete signed barrier with no history', async () => {
    const deviceId = randomUUID();
    await pool.query(
      `INSERT INTO devices (id, organization_id, status, public_key)
       VALUES ($1, $2, 'ACTIVE', $3)`, [deviceId, organizationId, publicKeyPem],
    );
    const configuration = await versions.issue(context('currency-clear-config'));
    const grant = await barriers.issueGrant(context('currency-clear-grant'), deviceId, configuration.version);
    await expect(service.change(context('currency-uncertain'), 1, 'USD', 'currency-uncertain-key'))
      .rejects.toMatchObject({ code: 'CURRENCY_LOCKED_BY_OFFLINE_UNCERTAINTY' });
    const barrier = await barriers.begin(context('currency-clear-begin'));
    const payload = JSON.stringify({ organizationId, barrierId: barrier.id, grantId: grant.id,
      epoch: barrier.epoch, sequence: 0, headHash: '0'.repeat(64), creationFrozen: true });
    const signer = createSign('SHA256');
    signer.update(payload);
    signer.end();
    await barriers.submitCheckpoint(context('currency-clear-checkpoint'), barrier.id, {
      grantId: grant.id, sequence: 0, headHash: '0'.repeat(64),
      signature: signer.sign(privateKey).toString('base64'),
    });
    await barriers.complete(context('currency-clear-complete'), barrier.id);
    expect(await service.change(context('currency-after-clear'), 1, 'USD', 'currency-after-clear-key'))
      .toEqual({ currency: 'USD', version: 2 });
  });

  it('keeps currency permanently locked after an exposed device is declared unrecoverable', async () => {
    const deviceId = randomUUID();
    await pool.query(
      `INSERT INTO devices (id, organization_id, status, public_key)
       VALUES ($1, $2, 'ACTIVE', $3)`, [deviceId, organizationId, publicKeyPem],
    );
    const configuration = await versions.issue(context('currency-lost-config'));
    await barriers.issueGrant(context('currency-lost-grant'), deviceId, configuration.version);
    expect(await unrecoverableDevices.declare(context('currency-lost-declaration'), deviceId))
      .toMatchObject({ permanentlyLocked: true });
    await expect(service.change(context('currency-permanent'), 1, 'USD', 'currency-permanent-key'))
      .rejects.toMatchObject({ code: 'CURRENCY_PERMANENTLY_LOCKED' });
  });
});
