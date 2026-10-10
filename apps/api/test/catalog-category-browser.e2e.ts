import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const organizationId = randomUUID(), categoryId = randomUUID();
const priorUrl = process.env.DATABASE_URL, priorOrigin = process.env.UCONEXT_PUBLIC_API_ORIGIN;
let app: INestApplication, container: StartedPostgreSqlContainer, pool: Pool, fixture: ChildProcess;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  const actor = await createGlobalUser(pool, { email: 'category-browser@example.com', password: 'correct-password' });
  await pool.query("INSERT INTO organizations(id,name,base_currency,timezone) VALUES ($1,'Browser tenant','ARS','UTC')", [organizationId]);
  await pool.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,'ADMIN')", [randomUUID(), organizationId, actor.id]);
  await pool.query("INSERT INTO catalog_categories(id,organization_id,name) VALUES ($1,$2,'Original navegador')", [categoryId, organizationId]);
  await pool.query("CREATE ROLE category_browser_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
  const runtimeUrl = new URL(container.getConnectionUri());
  runtimeUrl.username = 'category_browser_runtime'; runtimeUrl.password = 'runtime-password';
  process.env.DATABASE_URL = runtimeUrl.toString();
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
  fixture?.kill(); await app?.close(); await pool?.end(); await container?.stop();
  if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
  if (priorOrigin === undefined) delete process.env.UCONEXT_PUBLIC_API_ORIGIN; else process.env.UCONEXT_PUBLIC_API_ORIGIN = priorOrigin;
});

it('T236I: edits categories by keyboard on desktop/mobile against real HTTP and blocks offline administration', async () => {
  const directory = resolve(root, 'output/playwright');
  await mkdir(directory, { recursive: true });
  const config = resolve(directory, 't236i-browser.config.json');
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
    await cli('open', `http://localhost:4181/apps/web/test/browser/catalog-category.html?organizationId=${organizationId}`, '--config', config);
    await cli('snapshot');
    const result = await cli('run-code', '--filename', resolve(root, 'apps/web/test/browser/catalog-category.mjs'));
    const body: unknown = JSON.parse(result.result ?? 'null');
    expect(body).toMatchObject({ passed: true, patches: 2, backend: 'real NestJS/PostgreSQL runtime' });
    await writeFile(resolve(directory, 't236i-browser-result.json'), JSON.stringify(body, null, 2));
    expect((await pool.query('SELECT name,version FROM catalog_categories WHERE id=$1', [categoryId])).rows)
      .toEqual([{ name: 'Renombrada móvil', version: '3' }]);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='catalog_category.updated'", [categoryId])).rowCount).toBe(2);
    expect((await pool.query("SELECT 1 FROM idempotency_records WHERE organization_id=$1 AND scope='catalog_category.update' AND status='COMPLETED'", [organizationId])).rowCount).toBe(2);
    expect(await readFile(resolve(directory, 't236i-category-390.png'))).not.toHaveLength(0);
  } finally { await cli('close'); }
}, 120_000);
