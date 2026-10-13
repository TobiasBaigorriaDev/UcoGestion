import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const root = resolve('../..');
const organizationId = randomUUID(), branchId = randomUUID(), registerId = randomUUID(), deviceId = randomUUID(), sessionId = randomUUID();
const priorUrl = process.env.DATABASE_URL, priorOrigin = process.env.UCONEXT_PUBLIC_API_ORIGIN;
const keyNames = ['DEVICE_CERTIFICATE_KEY', 'OFFLINE_SIGNING_PRIVATE_KEY', 'OFFLINE_SIGNING_KEY_ID', 'OFFLINE_INGESTION_KEYS'] as const;
const priorKeys = new Map(keyNames.map(name => [name, process.env[name]]));
let app: INestApplication, container: StartedPostgreSqlContainer, pool: Pool, fixture: ChildProcess;

beforeAll(async () => {
  const signer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ingestion = generateKeyPairSync('rsa', { modulusLength: 3072 });
  process.env.DEVICE_CERTIFICATE_KEY = randomBytes(32).toString('base64url');
  process.env.OFFLINE_SIGNING_PRIVATE_KEY = signer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.OFFLINE_SIGNING_KEY_ID = 'browser-trusted';
  process.env.OFFLINE_INGESTION_KEYS = JSON.stringify({ activeKeyId: 'browser-ingestion', keys: { 'browser-ingestion': ingestion.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } });
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  const actor = await createGlobalUser(pool, { email: 'sale-id-browser@example.com', password: 'correct-password' });
  await pool.query("INSERT INTO organizations(id,name,base_currency,timezone) VALUES ($1,'Browser tenant','ARS','UTC')", [organizationId]);
  await pool.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,'OWNER')", [randomUUID(), organizationId, actor.id]);
  await pool.query("INSERT INTO branches(id,organization_id,name) VALUES ($1,$2,'Principal')", [branchId, organizationId]);
  await pool.query("INSERT INTO cash_registers(id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Caja online')", [registerId, organizationId, branchId]);
  await pool.query("INSERT INTO cash_registers(id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Caja offline')", [randomUUID(), organizationId, branchId]);
  await pool.query("INSERT INTO devices(id,organization_id,branch_id,authorized_by_user_id,authorized_at,status) VALUES ($1,$2,$3,$4,now(),'ACTIVE')", [deviceId, organizationId, branchId, actor.id]);
  await pool.query("INSERT INTO cash_sessions(id,organization_id,branch_id,cash_register_id,owner_user_id,device_id,origin,status,opening_cash,expected_cash,currency_code) VALUES ($1,$2,$3,$4,$5,$6,'ONLINE','OPEN',0,0,'ARS')", [sessionId, organizationId, branchId, registerId, actor.id, deviceId]);
  await pool.query("INSERT INTO catalog_items(id,organization_id,name,type,base_unit,price,price_version,track_inventory) VALUES ($1,$2,'Producto navegador','PRODUCT','UNIT',0,1,false)", [randomUUID(), organizationId]);
  await pool.query("CREATE ROLE sale_id_browser_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
  const runtimeUrl = new URL(container.getConnectionUri());
  runtimeUrl.username = 'sale_id_browser_runtime'; runtimeUrl.password = 'runtime-password';
  process.env.DATABASE_URL = runtimeUrl.toString();
  process.env.UCONEXT_PUBLIC_API_ORIGIN = 'http://localhost:4182';
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApi(module.createNestApplication());
  await app.listen(0, '127.0.0.1');
  const vite = resolve(dirname(require.resolve('vite/package.json', { paths: [dirname(require.resolve('vitest/package.json'))] })), 'bin/vite.js');
  fixture = spawn(process.execPath, [vite, '.', '--config', 'apps/web/test/browser/sale-id.vite.mjs',
    '--host', 'localhost', '--port', '4182', '--strictPort'], { cwd: root, windowsHide: true,
    env: { ...process.env, SALE_ID_TEST_API_URL: await app.getUrl() }, stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fixture.exitCode !== null) throw new Error('Sale ID fixture server failed');
    try { if ((await fetch('http://localhost:4182/apps/web/test/browser/sale-id.html', { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Startup. */ }
    await delay(200);
  }
  throw new Error('Sale ID fixture server unavailable');
}, 120_000);

afterAll(async () => {
  fixture?.kill(); await app?.close(); await pool?.end(); await container?.stop();
  if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
  if (priorOrigin === undefined) delete process.env.UCONEXT_PUBLIC_API_ORIGIN; else process.env.UCONEXT_PUBLIC_API_ORIGIN = priorOrigin;
  for (const [name, value] of priorKeys) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

async function runBrowserScenario(script: string): Promise<unknown> {
  const directory = resolve(root, 'output/playwright');
  await mkdir(directory, { recursive: true });
  const config = resolve(directory, 'd03-browser.config.json');
  await writeFile(config, JSON.stringify({ browser: { browserName: 'chromium', launchOptions: { headless: true } } }));
  const session = `sale-id-${randomUUID().slice(0, 8)}`;
  const cli = async (...args: string[]) => {
    let stdout: string;
    try {
      ({ stdout } = await execute(process.execPath, [require.resolve('@playwright/cli/playwright-cli.js'),
        `-s=${session}`, ...args, '--json'], { cwd: root, windowsHide: true, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') throw new Error(error.stdout, { cause: error });
      throw error;
    }
    const response: { isError?: boolean; error?: string; result?: string } = JSON.parse(stdout);
    if (response.isError) throw new Error(response.error ?? stdout);
    return response;
  };
  try {
    await cli('open', `http://localhost:4182/apps/web/test/browser/sale-id.html?organizationId=${organizationId}&branchId=${branchId}`, '--config', config);
    await cli('snapshot');
    const result = await cli('run-code', '--filename', resolve(root, 'apps/web/test/browser', script));
    return JSON.parse(result.result ?? 'null');
  } finally { await cli('close'); }
}

it('D03: confirms online/offline, recovers printed/downloaded ID and queries the same sale after real delivery', async () => {
    const directory = resolve(root, 'output/playwright');
    const body = await runBrowserScenario('sale-id.mjs');
    expect(body).toMatchObject({ passed: true, backend: 'real NestJS/PostgreSQL runtime' });
    await writeFile(resolve(directory, 'd03-browser-result.json'), JSON.stringify(body, null, 2));
    expect((await pool.query('SELECT id FROM sales WHERE organization_id=$1', [organizationId])).rowCount).toBe(2);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE organization_id=$1 AND action IN ('sale.confirmed','sale.confirmed.offline')", [organizationId])).rowCount).toBe(2);
    expect(await readFile(resolve(directory, 'd03-sale-id-390.png'))).not.toHaveLength(0);
}, 180_000);

it('sales history: filters, cursor pages, existing detail, cancellation and responsive accessibility', async () => {
  for (let index = 0; index < 27; index++) await pool.query(`INSERT INTO sales
    (id,organization_id,branch_id,cash_session_id,device_id,actor_user_id,session_owner_user_id,
     client_operation_id,currency_code,subtotal,discount,total,receipt_snapshot,confirmed_at)
    SELECT $1,organization_id,branch_id,cash_session_id,device_id,actor_user_id,session_owner_user_id,
      $1,currency_code,subtotal,discount,total,receipt_snapshot,'2025-01-01T12:00:00.123456Z'
    FROM sales WHERE organization_id=$2 ORDER BY confirmed_at LIMIT 1`, [randomUUID(), organizationId]);
  const result = await runBrowserScenario('sales-history.mjs');
  expect(result).toMatchObject({ passed: true, pages: [25, 2] });
  await writeFile(resolve(root, 'output/playwright/sales-history-result.json'), JSON.stringify(result, null, 2));
}, 180_000);
