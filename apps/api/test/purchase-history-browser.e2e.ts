import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const root = resolve('../..');
const organizationId = randomUUID(), branchId = randomUUID(), supplierId = randomUUID();
const itemId = randomUUID(), purchaseId = randomUUID();
const priorUrl = process.env.DATABASE_URL, priorOrigin = process.env.UCONEXT_PUBLIC_API_ORIGIN;
let app: INestApplication, container: StartedPostgreSqlContainer, pool: Pool, fixture: ChildProcess;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  const actor = await createGlobalUser(pool, { email: 'purchase-history-browser@example.com',
    password: 'correct-password' });
  await pool.query("INSERT INTO organizations(id,name,base_currency,timezone) VALUES ($1,'Browser compras','ARS','UTC')",
    [organizationId]);
  await pool.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,'OWNER')",
    [randomUUID(), organizationId, actor.id]);
  await pool.query("INSERT INTO branches(id,organization_id,name) VALUES ($1,$2,'Principal')",
    [branchId, organizationId]);
  await pool.query("INSERT INTO suppliers(id,organization_id,name) VALUES ($1,$2,'Bodega Sur')",
    [supplierId, organizationId]);
  await pool.query("INSERT INTO catalog_items(id,organization_id,name,type,base_unit,price,price_version,track_inventory) VALUES ($1,$2,'Cajas','PRODUCT','UNIT',0,1,false)",
    [itemId, organizationId]);
  await pool.query(`INSERT INTO purchases(id,organization_id,branch_id,supplier_id,actor_user_id,
    client_operation_id,confirmation_status,currency_code,total,supplier_snapshot)
    VALUES ($1,$2,$3,$4,$5,$1,'PENDING_PAYMENT','ARS','14.50',$6::jsonb)`,
  [purchaseId, organizationId, branchId, supplierId, actor.id, JSON.stringify({ name: 'Bodega Sur' })]);
  await pool.query(`INSERT INTO purchase_items(id,organization_id,purchase_id,item_id,item_name,
    item_type,unit,track_inventory,quantity,unit_cost,line_total,currency_code)
    VALUES ($1,$2,$3,$4,'Cajas','PRODUCT','UNIT',false,'2','7.25','14.50','ARS')`,
  [randomUUID(), organizationId, purchaseId, itemId]);
  await pool.query("CREATE ROLE purchase_history_browser_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
  const runtimeUrl = new URL(container.getConnectionUri());
  runtimeUrl.username = 'purchase_history_browser_runtime'; runtimeUrl.password = 'runtime-password';
  process.env.DATABASE_URL = runtimeUrl.toString();
  process.env.UCONEXT_PUBLIC_API_ORIGIN = 'http://localhost:4183';
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApi(module.createNestApplication());
  await app.listen(0, '127.0.0.1');
  const vite = resolve(dirname(require.resolve('vite/package.json', { paths: [dirname(require.resolve('vitest/package.json'))] })), 'bin/vite.js');
  fixture = spawn(process.execPath, [vite, '.', '--config', 'apps/web/test/browser/purchase-history.vite.mjs',
    '--host', 'localhost', '--port', '4183', '--strictPort'], { cwd: root, windowsHide: true,
    env: { ...process.env, PURCHASE_HISTORY_TEST_API_URL: await app.getUrl(),
      UCONEXT_PUBLIC_API_ORIGIN: 'http://localhost:4183' }, stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fixture.exitCode !== null) throw new Error('Purchase history fixture server failed');
    try { if ((await fetch('http://localhost:4183/apps/web/test/browser/purchase-history.html',
      { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Startup. */ }
    await delay(200);
  }
  throw new Error('Purchase history fixture server unavailable');
}, 120_000);

afterAll(async () => {
  fixture?.kill(); await app?.close(); await pool?.end(); await container?.stop();
  if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
  if (priorOrigin === undefined) delete process.env.UCONEXT_PUBLIC_API_ORIGIN;
  else process.env.UCONEXT_PUBLIC_API_ORIGIN = priorOrigin;
});

it('D07: browser shows historical products, graphs and authorized detail on mobile and desktop', async () => {
  const directory = resolve(root, 'output/playwright');
  await mkdir(directory, { recursive: true });
  const config = resolve(directory, 'd07-browser.config.json');
  await writeFile(config, JSON.stringify({ browser: { browserName: 'chromium', launchOptions: { headless: true } } }));
  const session = `purchase-history-${randomUUID().slice(0, 8)}`;
  const cli = async (...args: string[]) => {
    let stdout: string;
    try {
      ({ stdout } = await execute(process.execPath, [require.resolve('@playwright/cli/playwright-cli.js'),
        `-s=${session}`, ...args, '--json'], { cwd: root, windowsHide: true,
        timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') {
        throw new Error(error.stdout, { cause: error });
      }
      throw error;
    }
    const response: { isError?: boolean; error?: string; result?: string } = JSON.parse(stdout);
    if (response.isError) throw new Error(response.error ?? stdout);
    return response;
  };
  try {
    await cli('open', `http://localhost:4183/apps/web/test/browser/purchase-history.html?organizationId=${organizationId}&branchId=${branchId}`, '--config', config);
    await cli('snapshot');
    const result = await cli('run-code', '--filename', resolve(root, 'apps/web/test/browser/purchase-history.mjs'));
    expect(JSON.parse(result.result ?? 'null')).toMatchObject({ passed: true, widths: [390, 768, 1280] });
  } finally { await cli('close'); }
}, 180_000);
