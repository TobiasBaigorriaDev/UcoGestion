import { randomUUID } from 'node:crypto';

import { type INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { PUBLIC_ROUTE_METADATA } from '../src/modules/auth/public-route.decorator.js';

/**
 * Default deny for every HTTP route that the running application registers.
 * Routes are discovered from Nest metadata, so a new controller method is
 * covered automatically; a new public route must be added to the allowlist.
 */
const publicRoutes = new Set([
  'GET /api/v1',
  'GET /api/v1/health/live',
  'GET /api/v1/health/ready',
  'GET /api/v1/metrics',
  'POST /api/v1/auth/accept-invitation',
  'POST /api/v1/auth/forgot-password',
  'POST /api/v1/auth/reset-password',
  'POST /api/v1/auth/login',
  'GET /api/v1/auth/csrf',
  'POST /api/v1/auth/logout',
  // Platform access authenticates separately from tenant membership (requireSession + operator check).
  'POST /api/v1/platform/organizations',
  'POST /api/v1/platform/organizations/:organizationId/recover-owner',
  // Organization discovery and selection happen before a tenant context exists; both require a session.
  'GET /api/v1/organizations',
  'POST /api/v1/organizations/:organizationId/select',
  // Device channel: signed challenge/response with the device certificate, no cookie session.
  'POST /api/v1/offline/delivery/challenge',
  'POST /api/v1/offline/delivery/push',
]);

/** Tables whose writes are expected while authenticating the actors below. */
const authenticationTables = new Set(['auth_sessions', 'security_rate_limits']);

interface Route { readonly method: string; readonly path: string; readonly isPublic: boolean }

function discoverRoutes(app: INestApplication): Route[] {
  const routes: Route[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => unknown) | null;
      if (!controller) continue;
      const prefixes = [Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined].flat();
      const classPublic = Reflect.getMetadata(PUBLIC_ROUTE_METADATA, controller) === true;
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const paths = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        if (paths === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
        const isPublic = classPublic || Reflect.getMetadata(PUBLIC_ROUTE_METADATA, handler) === true;
        for (const prefix of prefixes) {
          for (const path of [paths].flat()) {
            const joined = ['/api/v1', prefix ?? '', path].map(part => part.replace(/^\/+|\/+$/g, ''))
              .filter(Boolean).join('/');
            routes.push({ method, path: `/${joined}`, isPublic });
          }
        }
      }
    }
  }
  return routes;
}

describe('T236K route-level default deny matrix', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let previousUrl: string | undefined;
  const organizationId = randomUUID();
  const foreignOrganizationId = randomUUID();
  const origin = 'http://localhost:3000';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    for (const id of [organizationId, foreignOrganizationId]) {
      await pool.query("INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'Matrix', 'ARS', 'UTC')", [id]);
    }
    const foreignOwner = await createGlobalUser(pool, { email: 'matrix-foreign@example.com', password: 'correct-password' });
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [randomUUID(), foreignOrganizationId, foreignOwner.id]);
    const inactive = await createGlobalUser(pool, { email: 'matrix-inactive@example.com', password: 'correct-password' });
    await pool.query(`INSERT INTO memberships (id, organization_id, user_id, role, status, deactivated_at)
      VALUES ($1, $2, $3, 'ADMIN', 'INACTIVE', now())`, [randomUUID(), organizationId, inactive.id]);
    const revoked = await createGlobalUser(pool, { email: 'matrix-revoked@example.com', password: 'correct-password' });
    await pool.query(`INSERT INTO memberships (id, organization_id, user_id, role, status, revoked_at)
      VALUES ($1, $2, $3, 'ADMIN', 'REVOKED', now())`, [randomUUID(), organizationId, revoked.id]);
    previousUrl = process.env.DATABASE_URL;
    await pool.query("CREATE ROLE route_matrix_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'route_matrix_runtime'; runtimeUrl.password = 'runtime-password';
    process.env.DATABASE_URL = runtimeUrl.toString();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close(); await pool?.end(); await container?.stop();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', origin).send({ email, password: 'correct-password' }).expect(204);
    const cookie = (response.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    return { cookie, csrf: csrf.body.csrfToken as string };
  }

  async function tableCounts(): Promise<Record<string, number>> {
    const tables = await pool.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'public' ORDER BY tablename`);
    const counts: Record<string, number> = {};
    for (const { name } of tables.rows) {
      if (authenticationTables.has(name)) continue;
      const result = await pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM "${name}"`);
      counts[name] = result.rows[0]?.count ?? 0;
    }
    return counts;
  }

  function send(route: Route, headers: Record<string, string>) {
    const path = route.path.replace(/:[A-Za-z]+/g, () => randomUUID());
    const agent = request(app.getHttpServer());
    const call = route.method === 'GET' ? agent.get(path) : route.method === 'POST' ? agent.post(path)
      : route.method === 'PATCH' ? agent.patch(path) : route.method === 'PUT' ? agent.put(path) : agent.delete(path);
    for (const [name, value] of Object.entries(headers)) call.set(name, value);
    return route.method === 'GET' ? call : call.send({});
  }

  it('exposes only the reviewed public routes', () => {
    const routes = discoverRoutes(app);
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.filter(route => route.isPublic).map(route => `${route.method} ${route.path}`).sort())
      .toEqual([...publicRoutes].sort());
  });

  it('denies every protected route without session, organization or active membership, with zero writes', async () => {
    const protectedRoutes = discoverRoutes(app).filter(route => !route.isPublic);
    const foreign = await login('matrix-foreign@example.com');
    const inactive = await login('matrix-inactive@example.com');
    const revoked = await login('matrix-revoked@example.com');
    const loggedOut = await login('matrix-foreign@example.com');
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Origin', origin)
      .set('Cookie', loggedOut.cookie).set('X-CSRF-Token', loggedOut.csrf).send({}).expect(204);
    const before = await tableCounts();
    const common = { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' };
    const scenarios: { name: string; headers: Record<string, string>; status: number; code: string }[] = [
      { name: 'no session', headers: { ...common, 'X-Organization-Id': organizationId }, status: 401, code: 'SESSION_INVALID' },
      { name: 'logged out session', headers: { ...common, Cookie: loggedOut.cookie, 'X-CSRF-Token': loggedOut.csrf,
        'X-Organization-Id': foreignOrganizationId }, status: 401, code: 'SESSION_INVALID' },
      { name: 'missing organization', headers: { ...common, Cookie: foreign.cookie, 'X-CSRF-Token': foreign.csrf },
        status: 403, code: 'ORGANIZATION_CONTEXT_REQUIRED' },
      { name: 'foreign tenant', headers: { ...common, Cookie: foreign.cookie, 'X-CSRF-Token': foreign.csrf,
        'X-Organization-Id': organizationId }, status: 403, code: 'MEMBERSHIP_INACTIVE' },
      { name: 'inactive membership', headers: { ...common, Cookie: inactive.cookie, 'X-CSRF-Token': inactive.csrf,
        'X-Organization-Id': organizationId }, status: 403, code: 'MEMBERSHIP_INACTIVE' },
      { name: 'revoked membership', headers: { ...common, Cookie: revoked.cookie, 'X-CSRF-Token': revoked.csrf,
        'X-Organization-Id': organizationId }, status: 403, code: 'MEMBERSHIP_INACTIVE' },
    ];
    const failures: string[] = [];
    for (const route of protectedRoutes) {
      for (const scenario of scenarios) {
        const response = await send(route, scenario.headers);
        const body = response.body as { code?: string } | undefined;
        if (response.status !== scenario.status || body?.code !== scenario.code
          || !String(response.headers['content-type']).startsWith('application/problem+json')) {
          failures.push(`${route.method} ${route.path} [${scenario.name}] → ${response.status} ${body?.code ?? ''}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(await tableCounts()).toEqual(before);
  }, 300_000);
});
