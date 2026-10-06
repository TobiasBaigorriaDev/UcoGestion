import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { recordOfflineReceipt } from '../src/modules/offline-sync/sync-operation-receipt.js';
import { readEnvelopeOrder } from '../src/modules/offline-sync/offline-envelope-order.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let runtime: Pool;
let transactions: TenantTransaction;
const org = randomUUID(); const foreign = randomUUID(); const actor = randomUUID();
const device = randomUUID(); const grant = randomUUID();
const context = (organizationId = org) => ({ organizationId, userId: actor, requestId: randomUUID() });
const input = { id: randomUUID(), organizationId: org, deviceId: device, grantId: grant,
  epoch: '1', sequence: '1', previousHash: '0'.repeat(64), operationHash: '1'.repeat(64),
  occurredAt: '2050-01-01T00:00:00.000Z' };
const write = <T>(scope: ReturnType<typeof context>, handler: (client: PoolClient) => Promise<T>) =>
  transactions.runWithOptionalAudit(scope, async client => ({ result: await handler(client) }));

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query("CREATE ROLE receipt_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
  const url = new URL(container.getConnectionUri()); url.username = 'receipt_runtime'; url.password = 'runtime-password';
  runtime = new Pool({ connectionString: url.toString() }); transactions = new TenantTransaction(runtime);
  await pool.query(`INSERT INTO users (id,email_normalized,password_hash,password_hash_version)
    VALUES ($1,'receipt-owner@example.com','$argon2id$v=19$owner',1)`, [actor]);
  await pool.query(`INSERT INTO organizations (id,name,base_currency,timezone)
    VALUES ($1,'Receipt','ARS','UTC'),($2,'Foreign','ARS','UTC')`, [org, foreign]);
  await pool.query(`INSERT INTO devices (id,organization_id,status,public_key) VALUES ($1,$2,'ACTIVE','fixture-key')`, [device, org]);
  await pool.query(`INSERT INTO configuration_versions
    (id,organization_id,version,snapshot,canonical_payload,signature,signing_key_id,public_key_pem)
    VALUES ($1,$2,1,'{"currency":"ARS"}','fixture','fixture','fixture','fixture')`, [randomUUID(), org]);
  await pool.query(`INSERT INTO offline_grants (id,organization_id,device_id,epoch,configuration_version,expires_at)
    VALUES ($1,$2,$3,1,1,now() + interval '72 hours')`, [grant, org, device]);
});
afterAll(async () => { await runtime?.end(); await pool?.end(); await container?.stop(); });

it('T198 persists device declaration and server reception separately, retaining both on retry', async () => {
  const before = Date.now();
  const result = await write(context(), client => recordOfflineReceipt(client, input));
  expect(result.occurredAt).toBe(input.occurredAt);
  expect(Date.parse(result.receivedAt)).toBeGreaterThanOrEqual(before - 1000);
  expect(Date.parse(result.receivedAt)).toBeLessThanOrEqual(Date.now() + 1000);
  expect(await write(context(), client => recordOfflineReceipt(client, input))).toEqual(result);
  await expect(write(context(), client => recordOfflineReceipt(client, { ...input, occurredAt: '2020-01-01T00:00:00.000Z' })))
    .rejects.toThrow();
});

it('T198 rejects timestamp forgery, cross-tenant writes and rewriting reception timestamps', async () => {
  await expect(write(context(foreign), client => recordOfflineReceipt(client, { ...input, id: randomUUID(), sequence: '2' })))
    .rejects.toThrow();
  await expect(write(context(), client => recordOfflineReceipt(client, { ...input, receivedAt: input.occurredAt })))
    .rejects.toThrow();
  await expect(pool.query(`UPDATE sync_operations SET status='ACKED', occurred_at=now() WHERE id=$1`, [input.id])).rejects.toThrow();
  await expect(pool.query(`UPDATE sync_operations SET status='ACKED', received_at='2050-01-01' WHERE id=$1`, [input.id])).rejects.toThrow();
  await write(context(), client => client.query("UPDATE sync_operations SET status='ACKED' WHERE id=$1", [input.id]));
  expect((await pool.query('SELECT occurred_at,received_at FROM sync_operations WHERE id=$1', [input.id])).rows[0].occurred_at.toISOString())
    .toBe(input.occurredAt);
});

it('T200B binds exact envelope bytes, serializes a device and preserves failed dependencies under RLS', async () => {
  const orderedDevice = randomUUID(); const sessionId = randomUUID(); const orderedId = randomUUID();
  const orderedGrant = randomUUID();
  const orderedBranch = randomUUID(), orderedRegister = randomUUID();
  await pool.query(`INSERT INTO branches (id,organization_id,name) VALUES ($1,$2,'Ordered')`, [orderedBranch,org]);
  await pool.query(`INSERT INTO cash_registers (id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Ordered')`, [orderedRegister,org,orderedBranch]);
  await pool.query(`INSERT INTO devices (id,organization_id,status,public_key) VALUES ($1,$2,'ACTIVE','fixture')`, [orderedDevice, org]);
  await pool.query('UPDATE devices SET branch_id=$2,authorized_by_user_id=$3,authorized_at=now() WHERE id=$1', [orderedDevice,orderedBranch,actor]);
  await pool.query(`INSERT INTO cash_sessions (id,organization_id,branch_id,cash_register_id,owner_user_id,device_id,
    origin,status,opening_cash,expected_cash,currency_code) VALUES ($1,$2,$3,$4,$5,$6,'OFFLINE','OPEN','0.00','0.00','ARS')`,
  [sessionId,org,orderedBranch,orderedRegister,actor,orderedDevice]);
  await pool.query(`INSERT INTO offline_grants (id,organization_id,device_id,epoch,configuration_version,expires_at)
    VALUES ($1,$2,$3,1,1,now()+interval '72 hours')`, [orderedGrant, org, orderedDevice]);
  const request = { ...input, id: orderedId, deviceId: orderedDevice, grantId: orderedGrant,
    envelope: { sessionId, sessionSequence: '1', kind: 'cash-session-open', hash: 'b'.repeat(64) } };
  const candidate = { id: orderedId, organizationId: org, deviceId: orderedDevice, sessionId, sequence: '1', sessionSequence: '1',
    kind: 'cash-session-open' as const, previousHash: null, operationHash: Buffer.from(input.operationHash, 'hex').toString('base64'), envelopeHash: 'b'.repeat(64) };
  expect(await write(context(), client => readEnvelopeOrder(client, candidate))).toBe('READY');
  const first = await write(context(), client => recordOfflineReceipt(client, request));
  expect(await write(context(), client => recordOfflineReceipt(client, request))).toEqual(first);
  await expect(write(context(), client => recordOfflineReceipt(client, { ...request, envelope: { ...request.envelope, hash: 'c'.repeat(64) } })))
    .rejects.toThrow('SYNC_RECEIPT_CONFLICT');
  const sale = { ...candidate, id: randomUUID(), sequence: '2', sessionSequence: '2', kind: 'sale-confirm' as const, previousHash: candidate.operationHash };
  expect(await write(context(), client => readEnvelopeOrder(client, sale))).toBe('WAITING_DEPENDENCY');
  expect(await write(context(foreign), client => readEnvelopeOrder(client, candidate))).toBe('CONFLICT');
  await expect(pool.query(`UPDATE sync_operations SET status='ACKED',envelope_hash=$2 WHERE id=$1`, [orderedId, 'c'.repeat(64)])).rejects.toThrow('immutable');
  await expect(write(context(), async client => {
    await client.query("UPDATE sync_operations SET status='ACKED' WHERE id=$1", [orderedId]);
    expect(await readEnvelopeOrder(client, sale)).toBe('READY');
    throw new Error('Rollback after dependency validation');
  })).rejects.toThrow('Rollback');
  expect(await write(context(), client => readEnvelopeOrder(client, sale))).toBe('WAITING_DEPENDENCY');
  expect((await pool.query('SELECT count(*)::integer AS count FROM sync_operations WHERE device_id=$1', [orderedDevice])).rows[0]?.count).toBe(1);
  const holder = await runtime.connect(); const waiter = await runtime.connect();
  let waiting: Promise<unknown> | undefined;
  try {
    for (const client of [holder, waiter]) {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id',$1,true)", [org]);
    }
    await readEnvelopeOrder(holder, candidate);
    const pid = (await waiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    waiting = readEnvelopeOrder(waiter, candidate);
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
      blocked = Boolean((await pool.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0]?.blocked);
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await holder.query('ROLLBACK');
    expect(await waiting).toBe('READY');
  } finally {
    await holder.query('ROLLBACK');
    await waiting;
    await waiter.query('ROLLBACK');
    holder.release(); waiter.release();
  }
  const rejectedSession = randomUUID(), rejectedId = randomUUID();
  const rejected = { ...request, id:rejectedId, sequence:'2', previousHash:input.operationHash,
    envelope:{...request.envelope,sessionId:rejectedSession,hash:'c'.repeat(64)} };
  await write(context(),async client => {
    await recordOfflineReceipt(client,rejected);
    await client.query("UPDATE sync_operations SET status='SECURITY_REJECTED' WHERE id=$1",[rejectedId]);
  });
  expect((await pool.query('SELECT id FROM cash_sessions WHERE id=$1',[rejectedSession])).rowCount).toBe(0);
  expect(await write(context(),client=>readEnvelopeOrder(client,{...candidate,id:rejectedId,sessionId:rejectedSession,
    sequence:'2',previousHash:candidate.operationHash,envelopeHash:'c'.repeat(64)}))).toBe('SECURITY_REJECTED');
  await expect(write(context(),client=>recordOfflineReceipt(client,{...rejected,id:randomUUID(),deviceId:device,grantId:grant,sequence:'3'})))
    .rejects.toThrow();
});

it('T198 migrates prior operations without inventing device time or changing historical server time', async () => {
  const legacyContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const legacy = new Pool({ connectionString: legacyContainer.getConnectionUri() });
  const folder = new URL('../src/database/migrations/', import.meta.url);
  try {
    for (const file of (await readdir(folder)).filter(name => /^\d{4}.*\.sql$/.test(name) && name < '0090').sort()) {
      await legacy.query(await readFile(new URL(file, folder), 'utf8'));
    }
    await legacy.query(`INSERT INTO organizations (id,name,base_currency,timezone) VALUES ($1,'Legacy','ARS','UTC')`, [org]);
    await legacy.query(`INSERT INTO devices (id,organization_id,status,public_key) VALUES ($1,$2,'ACTIVE','fixture')`, [device, org]);
    await legacy.query(`INSERT INTO configuration_versions (id,organization_id,version,snapshot,canonical_payload,signature,signing_key_id,public_key_pem)
      VALUES ($1,$2,1,'{"currency":"ARS"}','fixture','fixture','fixture','fixture')`, [randomUUID(), org]);
    await legacy.query(`INSERT INTO offline_grants (id,organization_id,device_id,epoch,configuration_version,expires_at)
      VALUES ($1,$2,$3,1,1,now() + interval '72 hours')`, [grant, org, device]);
    await legacy.query(`INSERT INTO sync_operations (id,organization_id,device_id,grant_id,epoch,sequence,prev_hash,operation_hash,status,created_at)
      VALUES ($1,$2,$3,$4,1,1,$5,$6,'ACKED','2025-01-01T12:00:00Z')`, [input.id, org, device, grant, input.previousHash, input.operationHash]);
    await legacy.query(await readFile(new URL('0090_offline_operation_times.sql', folder), 'utf8'));
    const row = (await legacy.query('SELECT occurred_at,received_at,created_at,status FROM sync_operations WHERE id=$1', [input.id])).rows[0];
    expect(row.occurred_at).toBeNull();
    expect(row.received_at.toISOString()).toBe('2025-01-01T12:00:00.000Z');
    expect(row.created_at.toISOString()).toBe('2025-01-01T12:00:00.000Z');
    expect(row.status).toBe('ACKED');
  } finally { await legacy.end(); await legacyContainer.stop(); }
});
