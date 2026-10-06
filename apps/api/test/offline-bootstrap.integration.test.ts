import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';

import { offlineGrantClaimsSchema, offlineGrantProofPayload } from '@uconext/shared';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { OfflineBootstrapService } from '../src/modules/offline-sync/offline-bootstrap.service.js';
import { RsaSyncEnvelopeDecryptor } from '../src/modules/offline-sync/sync-envelope-decryptor.js';
import { OfflineGrantService } from '../src/modules/offline-sync/offline-grant.service.js';
import { readHistoricalEnvelopeContext } from '../src/modules/offline-sync/historical-envelope-context.js';
import { OfflineCashOpeningImporter } from '../src/modules/cash/index.js';
import { recordOfflineReceipt } from '../src/modules/offline-sync/sync-operation-receipt.js';
import { DeviceCertificate } from '../src/modules/offline-sync/device-certificate.js';
import { DeliveryRejectedError, HistoricalIngestionUnavailableError, OfflineDeliveryService,
  UnconfiguredHistoricalDeliveryIngestion, deliveryProofPayload } from '../src/modules/offline-sync/offline-delivery.service.js';

describe('T186 signed bootstrap and committed exposure', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtime: Pool;
  let service: OfflineBootstrapService;
  let transactions: TenantTransaction;
  const org = randomUUID();
  const foreign = randomUUID();
  const actor = randomUUID();
  const branch = randomUUID();
  const otherBranch = randomUUID();
  const device = randomUUID();
  const cashier = randomUUID();
  const membership = randomUUID();
  const signing = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const custody = new RsaSyncEnvelopeDecryptor({ activeKeyId: 'old', keys: {
    old: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  } }, signing.privateKey, 'trusted');
  const signer = { keyId: 'trusted', publicKeyPem: signing.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: (payload: string) => sign('sha256', Buffer.from(payload), signing.privateKey).toString('base64') };
  const context = (userId = actor, organizationId = org) => ({ organizationId, userId, requestId: randomUUID() });
  const input = { deviceId: device, branchId: branch };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE ROLE bootstrap_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri());
    url.username = 'bootstrap_runtime'; url.password = 'runtime-password';
    runtime = new Pool({ connectionString: url.toString() });
    transactions = new TenantTransaction(runtime);
    service = new OfflineBootstrapService(transactions, signer, custody);
    await pool.query(`INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
      VALUES ($1, 'boot-owner@example.com', '$argon2id$v=19$owner', 1), ($2, 'boot-cashier@example.com', '$argon2id$v=19$cashier', 1)`, [actor, cashier]);
    await pool.query(`INSERT INTO organizations (id, name, base_currency, timezone)
      VALUES ($1, 'Bootstrap', 'ARS', 'America/Argentina/Mendoza'), ($2, 'Foreign', 'ARS', 'America/Argentina/Mendoza')`, [org, foreign]);
    await pool.query(`INSERT INTO memberships (id, organization_id, user_id, role)
      VALUES ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'CASHIER')`, [randomUUID(), org, actor, membership, cashier]);
    await pool.query(`INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Main'), ($3, $2, 'Other')`, [branch, org, otherBranch]);
    await pool.query(`INSERT INTO membership_branches (organization_id, membership_id, branch_id)
      VALUES ($1, $2, $3)`, [org, membership, branch]);
    await pool.query(`INSERT INTO devices (id, organization_id, branch_id, authorized_by_user_id, authorized_at, status, public_key, public_key_thumbprint)
      VALUES ($1, $2, $3, $4, now(), 'ACTIVE', $5, $6)`, [device, org, branch, actor, signer.publicKeyPem,
      createHash('sha256').update(signing.publicKey.export({ type: 'spki', format: 'der' })).digest('base64url')]);
    await pool.query(`INSERT INTO cash_registers (id, organization_id, branch_id, name)
      VALUES ($1, $2, $3, 'Main register'), ($4, $2, $5, 'Other register')`, [randomUUID(), org, branch, randomUUID(), otherBranch]);
  });
  afterAll(async () => { await runtime?.end(); await pool?.end(); await container?.stop(); });

  it('commits exposure and scope before returning a verifiable snapshot with ingestion and ACK keys', async () => {
    const result = await service.issue(context(cashier), input, 'bootstrap-first');
    expect(verify('sha256', Buffer.from(result.payload), signing.publicKey, Buffer.from(result.signature, 'base64'))).toBe(true);
    const payload = JSON.parse(result.payload);
    expect(payload.actorUserId).toBe(cashier);
    expect(payload.configuration.branches.map((row: { id: string }) => row.id)).toEqual([branch]);
    expect(payload.configuration.cashRegisters.every((row: { branchId: string }) => row.branchId === branch)).toBe(true);
    expect(payload.ingestionKey.signingKeyId).toBe('trusted');
    expect(JSON.parse(payload.ingestionKey.payload).keyId).toBe('old');
    expect(payload.ackKey.keyId).toBe('trusted');
    const exposure = await pool.query('SELECT grant_id FROM offline_configuration_exposures WHERE organization_id = $1', [org]);
    expect(exposure.rows).toContainEqual({ grant_id: payload.grantId });
    expect((await pool.query("SELECT count(*)::integer AS count FROM audit_events WHERE action = 'offline.bootstrap_issued'" )).rows[0]?.count).toBe(1);
  });

  it('replays exact bytes after a lost response and key rotation without duplicating exposure', async () => {
    const first = await service.issue(context(), input, 'lost-response');
    const next = generateKeyPairSync('rsa', { modulusLength: 3072 });
    custody.rotate('new', next.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    expect(await service.issue(context(), input, 'lost-response')).toEqual(first);
    const fresh = await service.issue(context(), input, 'new-publication');
    expect(JSON.parse(JSON.parse(fresh.payload).ingestionKey.payload).keyId).toBe('new');
    expect((await pool.query('SELECT count(*)::integer AS count FROM offline_configuration_exposures WHERE organization_id = $1', [org])).rows[0]?.count).toBe(3);
  });

  it('denies foreign tenants, wrong branches and revoked membership on replay', async () => {
    await expect(service.issue(context(actor, foreign), input, 'foreign')).rejects.toThrow();
    await expect(service.issue(context(cashier), { ...input, branchId: otherBranch }, 'other-branch')).rejects.toThrow();
    await pool.query("UPDATE memberships SET status = 'REVOKED', revoked_at = now() WHERE id = $1", [membership]);
    await expect(service.issue(context(cashier), input, 'bootstrap-first')).rejects.toThrow();
  });

  it('rolls back version, grant, exposure, audit and idempotency when signing fails', async () => {
    const before = (await pool.query('SELECT count(*)::integer AS count FROM configuration_versions')).rows[0]?.count;
    const failing = new OfflineBootstrapService(transactions, { ...signer, sign: () => { throw new Error('Custody unavailable'); } }, custody);
    await expect(failing.issue(context(), input, 'failed-signature')).rejects.toThrow('Custody unavailable');
    expect((await pool.query('SELECT count(*)::integer AS count FROM configuration_versions')).rows[0]?.count).toBe(before);
    expect((await pool.query("SELECT count(*)::integer AS count FROM idempotency_records WHERE key = 'failed-signature'")).rows[0]?.count).toBe(0);
  });

  it('refuses a newly loaded custody inventory that drops an exposed ingestion key', async () => {
    const next = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const incomplete = new RsaSyncEnvelopeDecryptor({ activeKeyId: 'missing-old', keys: {
      'missing-old': next.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    } }, signing.privateKey, 'trusted');
    const restarted = new OfflineBootstrapService(transactions, signer, incomplete);
    await expect(restarted.issue(context(), input, 'dropped-key')).rejects.toThrow('Historical ingestion key unavailable.');
  });

  it('T187 grants exactly 72 hours after completed sync and never renews from replay or failed sync', async () => {
    const bootstrap = await service.issue(context(), input, 'grant-bootstrap');
    const payload = JSON.parse(bootstrap.payload);
    const grants = new OfflineGrantService(transactions, signing.privateKey, 'trusted');
    const proofInput = { grantId: payload.grantId as string, bootstrapHash: createHash('sha256').update(bootstrap.payload).digest('hex'),
      deviceSequence: '0', headHash: null };
    const proof = sign('sha256', Buffer.from(offlineGrantProofPayload(proofInput)),
      { key: signing.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    const result = await grants.issue(context(), { ...proofInput, proof }, 'grant-completed');
    const [header, claims, signature] = result.grant.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toMatchObject({ alg: 'ES256', kid: 'trusted' });
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: signing.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature ?? '', 'base64url'))).toBe(true);
    const parsed = offlineGrantClaimsSchema.parse(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString()));
    expect(parsed).toMatchObject({ actorUserId: actor, organizationId: org, deviceId: device, branchId: branch,
      configurationVersion: payload.configurationVersion, permissions: { canDiscount: true } });
    expect(parsed.exp - parsed.iat).toBe(72 * 60 * 60);
    expect(await grants.issue(context(), { ...proofInput, proof }, 'grant-replay-different-key')).toEqual(result);
    const failed = { ...proofInput, deviceSequence: '1', headHash: 'a'.repeat(64) };
    const failedProof = sign('sha256', Buffer.from(offlineGrantProofPayload(failed)),
      { key: signing.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    await expect(grants.issue(context(), { ...failed, proof: failedProof }, 'failed-sync')).rejects.toThrow();
    const persisted = (await pool.query('SELECT expires_at FROM offline_grants WHERE id = $1', [payload.grantId])).rows[0]?.expires_at as Date;
    expect(Math.floor(persisted.getTime() / 1000)).toBe(parsed.exp);
  });

  it('T187 rejects falsified possession and incomplete sync before issuing any grant', async () => {
    const bootstrap = await service.issue(context(), input, 'grant-negative-bootstrap');
    const proofInput = { grantId: JSON.parse(bootstrap.payload).grantId as string,
      bootstrapHash: createHash('sha256').update(bootstrap.payload).digest('hex'), deviceSequence: '1', headHash: 'a'.repeat(64) };
    const grants = new OfflineGrantService(transactions, signing.privateKey, 'trusted');
    const proof = sign('sha256', Buffer.from(offlineGrantProofPayload(proofInput)),
      { key: signing.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    await expect(grants.issue(context(), { ...proofInput, proof: 'invalid' }, 'invalid-proof')).rejects.toThrow();
    await expect(grants.issue(context(), { ...proofInput, proof }, 'incomplete-sync')).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::integer AS count FROM offline_grant_authorizations WHERE grant_id = $1',
      [proofInput.grantId])).rows[0]?.count).toBe(0);
  });

  it('T200A reads original grant/configuration under RLS without reactivating revoked actors', async () => {
    const bootstrap = await service.issue(context(), input, 'history-bootstrap');
    const payload = JSON.parse(bootstrap.payload);
    const proofInput = { grantId: payload.grantId as string, bootstrapHash: createHash('sha256').update(bootstrap.payload).digest('hex'),
      deviceSequence: '0', headHash: null };
    const proof = sign('sha256', Buffer.from(offlineGrantProofPayload(proofInput)),
      { key: signing.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    const grant = (await new OfflineGrantService(transactions, signing.privateKey, 'trusted').issue(context(), { ...proofInput, proof }, 'history-grant')).grant;
    const request = { organizationId: org, deviceId: device, actorUserId: actor, grantJws: grant };
    const knowledge = { deviceSequence: null, actorSequence: null };
    const before = (await pool.query('SELECT count(*)::integer AS count FROM sync_operations')).rows[0]?.count;
    await pool.query("UPDATE devices SET status = 'REVOKED' WHERE id = $1", [device]);
    const history = await transactions.read(context(), client => readHistoricalEnvelopeContext(client, request, knowledge));
    expect(history).toMatchObject({ grantJws: grant, organizationId: org, deviceId: device, actorUserId: actor,
      bootstrapHash: proofInput.bootstrapHash, currency: 'ARS', knowledge });
    await expect(transactions.read(context(actor, foreign), client => readHistoricalEnvelopeContext(client, request, knowledge))).rejects.toThrow('OFFLINE_HISTORY_INVALID');
    await expect(transactions.read(context(), client => readHistoricalEnvelopeContext(client, { ...request, actorUserId: cashier }, knowledge))).rejects.toThrow('OFFLINE_HISTORY_INVALID');
    expect((await pool.query('SELECT status FROM devices WHERE id = $1', [device])).rows[0]?.status).toBe('REVOKED');
    expect((await pool.query('SELECT count(*)::integer AS count FROM sync_operations')).rows[0]?.count).toBe(before);
    await pool.query("UPDATE devices SET status = 'ACTIVE' WHERE id = $1", [device]);
  });

  it('T213 serializes imported openings, persists conflicts and replays the initial result', async () => {
    const bootstrap = await service.issue(context(), input, 'import-opening-bootstrap');
    const payload = JSON.parse(bootstrap.payload);
    const proofInput = { grantId: payload.grantId as string, bootstrapHash: createHash('sha256').update(bootstrap.payload).digest('hex'),
      deviceSequence: '0', headHash: null };
    const proof = sign('sha256', Buffer.from(offlineGrantProofPayload(proofInput)),
      { key: signing.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    await new OfflineGrantService(transactions, signing.privateKey, 'trusted').issue(context(), { ...proofInput, proof }, 'import-opening-grant');
    const importer = new OfflineCashOpeningImporter();
    const make = () => ({ id: randomUUID(), operationId: randomUUID(), organizationId: org, actorUserId: actor, deviceId: device,
      branchId: branch, cashRegisterId: payload.configuration.cashRegisters[0].id as string,
      openingCash: '10.00', currency: 'ARS', openedAt: payload.serverTime as string, grantId: payload.grantId as string });
    const firstInput = make(), secondInput = make();
    const apply = (request: ReturnType<typeof make>, scope = context()) => transactions.runWithOptionalAudit(scope,
      async client => {
        const index = request.id === firstInput.id ? '1' : '2';
        await recordOfflineReceipt(client, { id: request.operationId, organizationId: org, deviceId: device,
          grantId: request.grantId, epoch:'1', sequence:index, previousHash: index==='1' ? '0'.repeat(64) : '1'.repeat(64),
          operationHash:index.repeat(64), occurredAt:request.openedAt,
          envelope:{sessionId:request.id,sessionSequence:'1',kind:'cash-session-open',hash:index.repeat(64)} });
        const result = await importer.apply(client, scope, request);
        await client.query("UPDATE sync_operations SET status='ACKED' WHERE id=$1 AND status='PENDING'", [request.operationId]);
        return { result };
      });
    const results = await Promise.all([apply(firstInput), apply(secondInput)]);
    expect(results.map(result => result.status).sort()).toEqual(['CONFLICTED', 'OPEN']);
    expect((await pool.query('SELECT status FROM sync_operations WHERE id=ANY($1::uuid[])',
      [[firstInput.operationId,secondInput.operationId]])).rows.map(row => row.status)).toEqual(['ACKED','ACKED']);
    expect(await apply(firstInput)).toEqual(results[0]);
    const row = (await pool.query('SELECT status,expected_cash FROM cash_sessions WHERE id=$1', [firstInput.id])).rows[0];
    expect(row?.expected_cash).toBe('10.00');
    expect((await pool.query("SELECT count(*)::integer AS count FROM audit_events WHERE action='cash.session.opened.offline'")).rows[0]?.count).toBe(2);
    await expect(apply({ ...firstInput, openingCash: '11.00' })).rejects.toThrow();
    await expect(apply(make(), context(actor, foreign))).rejects.toThrow();
    const failed = make();
    await expect(transactions.runWithOptionalAudit(context(), async client => {
      await importer.apply(client, context(), failed);
      throw new Error('Simulated receipt failure');
    })).rejects.toThrow('Simulated');
    expect((await pool.query('SELECT id FROM cash_sessions WHERE id=$1', [failed.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM idempotency_records WHERE key=$1', [failed.operationId])).rowCount).toBe(0);
  });

  it('T201A enforces nonce RLS and concurrent single use with the non-owner runtime role', async () => {
    const certificates = new DeviceCertificate(randomBytes(32));
    const certificate = certificates.issue({organizationId:org,deviceId:device,thumbprint:certificates.thumbprint(signer.publicKeyPem)});
    const delivery = new OfflineDeliveryService(runtime, () => ({certificates,signingKey:signing.privateKey,keyId:'trusted',rateLimitPepper:'test-delivery-pepper-32-bytes'}),
      () => 'http://localhost:3000',new UnconfiguredHistoricalDeliveryIngestion());
    const {challenge} = await delivery.challenge({certificate},'127.0.0.1');
    expect((await transactions.read(context(actor,foreign),client=>client.query('SELECT jti_hash FROM sync_delivery_challenges'))).rowCount).toBe(0);
    expect((await transactions.read(context(),client=>client.query('SELECT jti_hash FROM sync_delivery_challenges'))).rowCount).toBe(1);
    const ciphertext=randomBytes(32);
    const envelopes=[JSON.stringify({version:1,keyId:'old',operationId:randomUUID(),certificate,iv:randomBytes(12).toString('base64'),
      wrappedCek:randomBytes(384).toString('base64'),ciphertext:ciphertext.toString('base64'),
      ciphertextHash:createHash('sha256').update(ciphertext).digest('base64'),signature:randomBytes(64).toString('base64')})];
    const proof=sign('sha256',Buffer.from(deliveryProofPayload(challenge,envelopes)),{key:signing.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
    const push={certificate,challenge,envelopes,proof};
    const outcomes=await Promise.allSettled([delivery.push(push,'127.0.0.1'),delivery.push(push,'127.0.0.1')]);
    const errors=outcomes.map(outcome=>outcome.status==='rejected' ? outcome.reason : null);
    expect(errors.filter(error=>error instanceof HistoricalIngestionUnavailableError)).toHaveLength(1);
    expect(errors.filter(error=>error instanceof DeliveryRejectedError)).toHaveLength(1);
    expect((await pool.query('SELECT used_at FROM sync_delivery_challenges')).rows[0]?.used_at).toBeInstanceOf(Date);
  });

  it('serializes concurrent retries and denies new exposure during a D01 barrier', async () => {
    const results = await Promise.all([service.issue(context(), input, 'concurrent-bootstrap'),
      service.issue(context(), input, 'concurrent-bootstrap')]);
    expect(results[0]).toEqual(results[1]);
    const before = (await pool.query('SELECT count(*)::integer AS count FROM offline_configuration_exposures')).rows[0]?.count;
    const barrierId = randomUUID();
    await pool.query(`INSERT INTO configuration_barriers (id, organization_id, epoch, status)
      VALUES ($1, $2, 1, 'ACTIVE')`, [barrierId, org]);
    await expect(service.issue(context(), input, 'during-barrier')).rejects.toThrow('La configuración está congelada.');
    expect((await pool.query('SELECT count(*)::integer AS count FROM offline_configuration_exposures')).rows[0]?.count).toBe(before);
  });
});
