import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Controller, Put, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { CsrfService } from '../src/modules/auth/csrf.service.js';

const origin = 'http://localhost:3000';
const credentials = { email: 'csrf@example.com', password: 'correct-password' };

@Controller('mutation-probe')
class MutationProbeController {
  @Put()
  update(): { ok: true } {
    return { ok: true };
  }
}

describe('CSRF and request integrity', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let userId: string;
  let organizationId: string;
  let previousDatabaseUrl: string | undefined;
  let previousPublicApiOrigin: string | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    userId = (await createGlobalUser(pool, credentials)).id;
    organizationId = randomUUID();
    await pool.query(
      "INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'America/Argentina/Mendoza')",
      [organizationId],
    );
    await pool.query(
      "INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [randomUUID(), organizationId, userId],
    );
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousPublicApiOrigin = process.env.UCONEXT_PUBLIC_API_ORIGIN;
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.UCONEXT_PUBLIC_API_ORIGIN = origin;
    const module = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [MutationProbeController],
    }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousPublicApiOrigin === undefined) delete process.env.UCONEXT_PUBLIC_API_ORIGIN;
    else process.env.UCONEXT_PUBLIC_API_ORIGIN = previousPublicApiOrigin;
  });

  async function signIn(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-origin')
      .send(credentials)
      .expect(204);
    const cookie = (response.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0];
    expect(cookie).toMatch(/^__Host-uco_session=[A-Za-z0-9_-]{43}$/);
    return cookie ?? '';
  }

  it('rejects missing or foreign origins, cross-site fetches, and non-JSON login', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(credentials)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', 'https://attacker.example')
      .send(credentials)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'cross-site')
      .send(credentials)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(credentials))
      .expect(415);
  });

  it('issues a stable session-bound token without caching and rejects token reuse across sessions', async () => {
    const firstCookie = await signIn();
    const secondCookie = await signIn();
    const first = await request(app.getHttpServer())
      .get('/api/v1/auth/csrf')
      .set('Cookie', firstCookie)
      .expect(200);
    const repeat = await request(app.getHttpServer())
      .get('/api/v1/auth/csrf')
      .set('Cookie', firstCookie)
      .expect(200);
    expect(first.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repeat.body.csrfToken).toBe(first.body.csrfToken);
    expect(first.headers['cache-control']).toBe('no-store');

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-origin')
      .set('Cookie', secondCookie)
      .set('X-CSRF-Token', first.body.csrfToken as string)
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-origin')
      .set('Cookie', firstCookie)
      .set('X-CSRF-Token', first.body.csrfToken as string)
      .send({})
      .expect(204);
    await request(app.getHttpServer())
      .get('/api/v1/auth/csrf')
      .set('Cookie', firstCookie)
      .expect(401);
  });

  it('blocks logout without a valid CSRF header or request integrity', async () => {
    const cookie = await signIn();
    const tokenResponse = await request(app.getHttpServer())
      .get('/api/v1/auth/csrf')
      .set('Cookie', cookie)
      .expect(200);
    const csrfToken = tokenResponse.body.csrfToken as string;

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', 'null')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-site')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('value=1')
      .expect(415);
  });

  it('accepts the configured origin with a trailing slash', async () => {
    process.env.UCONEXT_PUBLIC_API_ORIGIN = `${origin}/`;
    try {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .send(credentials)
        .expect(204);
    } finally {
      process.env.UCONEXT_PUBLIC_API_ORIGIN = origin;
    }
  });

  it('allows the runtime role to create a session with its CSRF token', async () => {
    const client = await pool.connect();
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE uco_app');
      await client.query(
        `INSERT INTO auth_sessions
          (id, user_id, token_hash, csrf_token, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '12 hours', now() + interval '7 days')`,
        [randomUUID(), userId, createHash('sha256').update(sessionToken).digest('hex'), csrfToken],
      );
      const csrf = new CsrfService(client);
      expect(await csrf.issue(sessionToken)).toBe(csrfToken);
      expect(await csrf.verify(sessionToken, csrfToken)).toBe(true);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('applies CSRF to a protected tenant mutation, not just logout', async () => {
    const cookie = await signIn();
    const csrfResponse = await request(app.getHttpServer())
      .get('/api/v1/auth/csrf')
      .set('Cookie', cookie)
      .expect(200);
    await request(app.getHttpServer())
      .put('/api/v1/mutation-probe')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .set('X-Organization-Id', organizationId)
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .put('/api/v1/mutation-probe')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrfResponse.body.csrfToken as string)
      .send({})
      .expect(200, { ok: true });
  });
});
