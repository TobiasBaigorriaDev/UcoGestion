import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { ConfigurationBarrierService } from '../src/modules/offline-sync/configuration-barrier.service.js';
import { ConfigurationVersionService } from '../src/modules/offline-sync/configuration-version.service.js';

describe('configuration barrier', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let barriers: ConfigurationBarrierService;
  let versions: ConfigurationVersionService;
  const organizationId = randomUUID();
  const ownerId = randomUUID();
  const firstDeviceId = randomUUID();
  const secondDeviceId = randomUUID();
  const firstKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const secondKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const context = (requestId: string) => ({ organizationId, requestId, userId: ownerId });
  const sign = (payload: string, privateKey: typeof firstKey.privateKey) => {
    const signer = createSign('SHA256');
    signer.update(payload);
    signer.end();
    return signer.sign(privateKey).toString('base64');
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE ROLE uco_barrier_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri());
    url.username = 'uco_barrier_runtime';
    url.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: url.toString() });
    const transactions = new TenantTransaction(runtimePool);
    barriers = new ConfigurationBarrierService(transactions);
    versions = new ConfigurationVersionService(transactions, {
      keyId: 'barrier-test-key',
      publicKeyPem: firstKey.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      sign: (payload) => sign(payload, firstKey.privateKey),
    });
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
       VALUES ($1, 'barrier-owner@example.com', '$argon2id$v=19$owner', 1)`, [ownerId],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone)
       VALUES ($1, 'Barrier tenant', 'ARS', 'America/Argentina/Mendoza')`, [organizationId],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role)
       VALUES ($1, $2, $3, 'OWNER')`, [randomUUID(), organizationId, ownerId],
    );
    for (const [deviceId, key] of [[firstDeviceId, firstKey], [secondDeviceId, secondKey]] as const) {
      await pool.query(
        `INSERT INTO devices (id, organization_id, status, public_key)
         VALUES ($1, $2, 'ACTIVE', $3)`,
        [deviceId, organizationId, key.publicKey.export({ format: 'pem', type: 'spki' }).toString()],
      );
    }
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('waits for every grant checkpoint and blocks old grant issuance during the barrier', async () => {
    const config = await versions.issue(context('barrier-config'));
    const grantA = await barriers.issueGrant(context('barrier-grant-a'), firstDeviceId, config.version);
    const grantB = await barriers.issueGrant(context('barrier-grant-b'), secondDeviceId, config.version);
    const grantC = await barriers.issueGrant(context('barrier-grant-c'), firstDeviceId, config.version);
    expect((await pool.query(
      'SELECT count(*)::integer AS count FROM offline_configuration_exposures WHERE grant_id IN ($1, $2, $3)',
      [grantA.id, grantB.id, grantC.id],
    )).rows[0]?.count).toBe(3);
    await versions.recordExposure(context('barrier-exposure-a'), grantA.id);
    await versions.recordExposure(context('barrier-exposure-b'), grantB.id);

    const barrier = await barriers.begin(context('barrier-begin'));
    await expect(barriers.issueGrant(context('barrier-grant-blocked'), firstDeviceId, config.version))
      .rejects.toMatchObject({ code: 'CONFIGURATION_BARRIER_ACTIVE' });
    await barriers.submitCheckpoint(context('barrier-checkpoint-a'), barrier.id, {
      grantId: grantA.id, sequence: 0, headHash: '0'.repeat(64),
      signature: sign(JSON.stringify({ organizationId, barrierId: barrier.id, grantId: grantA.id,
        epoch: barrier.epoch, sequence: 0, headHash: '0'.repeat(64), creationFrozen: true }), firstKey.privateKey),
    });
    await expect(barriers.complete(context('barrier-incomplete'), barrier.id))
      .rejects.toMatchObject({ code: 'CONFIGURATION_CHECKPOINT_MISSING' });
    await barriers.submitCheckpoint(context('barrier-checkpoint-b'), barrier.id, {
      grantId: grantB.id, sequence: 0, headHash: '0'.repeat(64),
      signature: sign(JSON.stringify({ organizationId, barrierId: barrier.id, grantId: grantB.id,
        epoch: barrier.epoch, sequence: 0, headHash: '0'.repeat(64), creationFrozen: true }), secondKey.privateKey),
    });
    await expect(barriers.complete(context('barrier-still-incomplete'), barrier.id))
      .rejects.toMatchObject({ code: 'CONFIGURATION_CHECKPOINT_MISSING' });
    await barriers.submitCheckpoint(context('barrier-checkpoint-c'), barrier.id, {
      grantId: grantC.id, sequence: 0, headHash: '0'.repeat(64),
      signature: sign(JSON.stringify({ organizationId, barrierId: barrier.id, grantId: grantC.id,
        epoch: barrier.epoch, sequence: 0, headHash: '0'.repeat(64), creationFrozen: true }), firstKey.privateKey),
    });
    await barriers.complete(context('barrier-complete'), barrier.id);
    expect((await pool.query(
      'SELECT count(*)::integer AS count FROM offline_configuration_exposures WHERE organization_id = $1 AND cleared_at IS NULL',
      [organizationId],
    )).rows[0]?.count).toBe(0);
    expect((await pool.query(
      'SELECT count(*)::integer AS count FROM offline_grants WHERE organization_id = $1 AND closed_at IS NOT NULL',
      [organizationId],
    )).rows[0]?.count).toBe(3);
    await expect(pool.query(
      `INSERT INTO sync_operations
         (id, organization_id, device_id, grant_id, epoch, sequence, prev_hash, operation_hash, status)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 'PENDING')`,
      [randomUUID(), organizationId, firstDeviceId, grantA.id, grantA.epoch,
        '0'.repeat(64), 'a'.repeat(64)],
    )).rejects.toThrow('closed or stale grant');
  });

  it('rejects a checkpoint older than ACKed operations and an invalid device signature', async () => {
    const config = await versions.issue(context('barrier-stale-config'));
    const grant = await barriers.issueGrant(context('barrier-stale-grant'), firstDeviceId, config.version);
    const operationHash = 'a'.repeat(64);
    await pool.query(
      `INSERT INTO sync_operations
         (id, organization_id, device_id, grant_id, epoch, sequence, prev_hash, operation_hash, status)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 'ACKED')`,
      [randomUUID(), organizationId, firstDeviceId, grant.id, grant.epoch,
        '0'.repeat(64), operationHash],
    );
    await expect(pool.query(
      `UPDATE sync_operations SET status = 'PENDING'
       WHERE organization_id = $1 AND device_id = $2 AND sequence = 1`,
      [organizationId, firstDeviceId],
    )).rejects.toThrow('immutable after a definitive result');
    const race = await Promise.allSettled([
      barriers.begin(context('barrier-stale-begin')),
      barriers.issueGrant(context('barrier-racing-grant'), secondDeviceId, config.version),
    ]);
    expect(race[0]?.status).toBe('fulfilled');
    const begun = race[0];
    if (begun?.status !== 'fulfilled') throw new Error('La barrera no inició.');
    const barrier = begun.value;
    if (race[1]?.status === 'rejected') {
      expect(race[1].reason).toMatchObject({ code: 'CONFIGURATION_BARRIER_ACTIVE' });
    }
    await expect(barriers.issueGrant(context('barrier-grant-after-start'), secondDeviceId, config.version))
      .rejects.toMatchObject({ code: 'CONFIGURATION_BARRIER_ACTIVE' });
    const payload = JSON.stringify({ organizationId, barrierId: barrier.id, grantId: grant.id,
      epoch: barrier.epoch, sequence: 0, headHash: '0'.repeat(64), creationFrozen: true });
    await expect(barriers.submitCheckpoint(context('barrier-stale-checkpoint'), barrier.id, {
      grantId: grant.id, sequence: 0, headHash: '0'.repeat(64), signature: sign(payload, firstKey.privateKey),
    })).rejects.toMatchObject({ code: 'CONFIGURATION_CHECKPOINT_STALE' });
    const validPayload = JSON.stringify({ organizationId, barrierId: barrier.id, grantId: grant.id,
      epoch: barrier.epoch, sequence: 1, headHash: operationHash, creationFrozen: true });
    await expect(barriers.submitCheckpoint(context('barrier-bad-signature'), barrier.id, {
      grantId: grant.id, sequence: 1, headHash: operationHash,
      signature: sign(validPayload, secondKey.privateKey),
    })).rejects.toMatchObject({ code: 'CONFIGURATION_CHECKPOINT_SIGNATURE_INVALID' });

    await pool.query(
      `INSERT INTO sync_operations
         (id, organization_id, device_id, grant_id, epoch, sequence, prev_hash, operation_hash, status)
       VALUES ($1, $2, $3, $4, $5, 2, $6, $7, 'ACKED')`,
      [randomUUID(), organizationId, firstDeviceId, grant.id, grant.epoch,
        'f'.repeat(64), 'b'.repeat(64)],
    );
    const brokenPayload = JSON.stringify({ organizationId, barrierId: barrier.id, grantId: grant.id,
      epoch: barrier.epoch, sequence: 2, headHash: 'b'.repeat(64), creationFrozen: true });
    await expect(barriers.submitCheckpoint(context('barrier-broken-chain'), barrier.id, {
      grantId: grant.id, sequence: 2, headHash: 'b'.repeat(64),
      signature: sign(brokenPayload, firstKey.privateKey),
    })).rejects.toMatchObject({ code: 'CONFIGURATION_CHECKPOINT_STALE' });
  });
});
