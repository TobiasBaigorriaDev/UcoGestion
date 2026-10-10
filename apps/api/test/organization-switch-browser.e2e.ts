import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const root = resolve('../..');
const organizationId = randomUUID(), other = randomUUID(), branchId = randomUUID(), otherBranch = randomUUID();
const custodyEnvironment = ['OFFLINE_SIGNING_PRIVATE_KEY', 'OFFLINE_SIGNING_KEY_ID', 'OFFLINE_INGESTION_KEYS', 'DEVICE_CERTIFICATE_KEY'] as const;
const priorCustody = Object.fromEntries(custodyEnvironment.map(key => [key, process.env[key]]));
const deniedOrganizations = [randomUUID(), randomUUID(), randomUUID()];
let userId: string;
const priorUrl = process.env.DATABASE_URL, priorOrigin = process.env.UCONEXT_PUBLIC_API_ORIGIN;
let app: INestApplication, container: StartedPostgreSqlContainer, pool: Pool, fixture: ChildProcess;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  const actor = await createGlobalUser(pool, { email: 'category-browser@example.com', password: 'correct-password' });
  userId = actor.id;
  await pool.query("INSERT INTO organizations(id,name,base_currency,timezone,status) VALUES ($1,'Foreign','ARS','UTC','ACTIVE'),($2,'Inactive organization','ARS','UTC','INACTIVE'),($3,'Inactive membership','ARS','UTC','ACTIVE')", deniedOrganizations);
  await pool.query("INSERT INTO memberships(id,organization_id,user_id,role,status,deactivated_at) VALUES ($1,$2,$3,'OWNER','ACTIVE',NULL),($4,$5,$3,'ADMIN','INACTIVE',now())", [randomUUID(),deniedOrganizations[1],userId,randomUUID(),deniedOrganizations[2]]);
  await pool.query("INSERT INTO organizations(id,name,base_currency,timezone) VALUES ($1,'First','ARS','UTC'),($2,'Second','ARS','UTC')", [organizationId, other]);
  await pool.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,'OWNER')", [randomUUID(), organizationId, actor.id]);
  await pool.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,'EMPLOYEE')", [randomUUID(), other, actor.id]);
  await pool.query("INSERT INTO branches(id,organization_id,name) VALUES ($1,$2,'First branch'),($3,$4,'Second branch')", [branchId,organizationId,otherBranch,other]);
  await pool.query("CREATE ROLE category_browser_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
  const runtimeUrl = new URL(container.getConnectionUri());
  runtimeUrl.username = 'category_browser_runtime'; runtimeUrl.password = 'runtime-password';
  process.env.DATABASE_URL = runtimeUrl.toString();
  const signer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ingestion = generateKeyPairSync('rsa', { modulusLength: 3072 });
  process.env.OFFLINE_SIGNING_PRIVATE_KEY = signer.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  process.env.OFFLINE_SIGNING_KEY_ID = 'trusted';
  process.env.DEVICE_CERTIFICATE_KEY = randomBytes(32).toString('base64url');
  process.env.OFFLINE_INGESTION_KEYS = JSON.stringify({ activeKeyId: 'test', keys: { test: ingestion.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() } });
  await pool.query("INSERT INTO cash_registers(id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Offline register')", [randomUUID(),organizationId,branchId]);
  process.env.UCONEXT_PUBLIC_API_ORIGIN = 'http://localhost:4181';
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApi(module.createNestApplication());
  await app.listen(0, '127.0.0.1');
  const vite = resolve(dirname(require.resolve('vite/package.json', { paths: [dirname(require.resolve('vitest/package.json'))] })), 'bin/vite.js');
  fixture = spawn(process.execPath, [vite, '.', '--config', 'apps/web/test/browser/catalog-category.vite.mjs',
    '--host', 'localhost', '--port', '4181', '--strictPort'], { cwd: root, windowsHide: true,
    env: { ...process.env, CATALOG_TEST_API_URL: await app.getUrl() }, stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fixture.exitCode !== null) throw new Error('Category fixture server failed');
    try { if ((await fetch('http://localhost:4181/apps/web/test/browser/catalog-category.html', { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Startup. */ }
    await delay(200);
  }
  throw new Error('Category fixture server unavailable');
}, 120_000);

afterAll(async () => {
  for (const key of custodyEnvironment) { if (priorCustody[key] === undefined) delete process.env[key]; else process.env[key] = priorCustody[key]; }
  fixture?.kill(); await app?.close(); await pool?.end(); await container?.stop();
  if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
  if (priorOrigin === undefined) delete process.env.UCONEXT_PUBLIC_API_ORIGIN; else process.env.UCONEXT_PUBLIC_API_ORIGIN = priorOrigin;
});

async function runBrowser(path: string, filename: string, authenticated: boolean): Promise<unknown> {
  const directory = resolve(root, 'output/playwright');
  await mkdir(directory, { recursive: true });
  const config = resolve(directory, 't236k-switch-browser.config.json');
  await writeFile(config, JSON.stringify({ browser: { browserName: 'chromium', launchOptions: { headless: true } } }));
  const session = `category-${randomUUID().slice(0, 8)}`;
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
    await cli('open', `http://localhost:4181/apps/web/test/browser/${path}.html?organizationId=${organizationId}&other=${other}&userId=${userId}&branchId=${branchId}&denied=${deniedOrganizations.join(',')}`, '--config', config);
    if (authenticated) await cli('run-code', 'async page => { const origin = new URL(page.url()).origin; const login = await page.request.post(origin + "/api/v1/auth/login", { headers: { Origin: origin }, data: { email: "category-browser@example.com", password: "correct-password" } }); if (login.status() !== 204) throw new Error("Login failed"); await page.reload(); }');
    await cli('snapshot');
    const result = await cli('run-code', '--filename', resolve(root, `apps/web/test/browser/${path}.mjs`));
    const body: unknown = JSON.parse(result.result ?? 'null');
    expect(body).toMatchObject({ passed: true });
    await writeFile(resolve(directory, filename), JSON.stringify(body, null, 2));
    return body;
  } finally { await cli('close'); }
}

it('RF-03 real membership switch retires prior branch, keys, private state and other tabs', async () => {
  await runBrowser('organization-switch', 't236k-switch-browser-result.json', true);
}, 120_000);

it('RF-116 real offline opening rejects missing online auth/device/bootstrap/sync then succeeds with verified grant', async () => {
  const evidence = z.object({ passed: z.literal(true), deviceId: z.uuid(), grantId: z.uuid() }).parse(
    await runBrowser('offline-prerequisites', 't236k-offline-prerequisites-result.json', false));
  expect((await pool.query('SELECT 1 FROM offline_grant_authorizations WHERE grant_id=$1', [evidence.grantId])).rowCount).toBe(1);
  expect((await pool.query('SELECT 1 FROM cash_sessions WHERE device_id=$1', [evidence.deviceId])).rowCount).toBe(0);
}, 120_000);
