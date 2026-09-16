import { createHash } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';

describe('login session cookie', () => {
  let app: INestApplication;
  let pool: Pool;
  let container: StartedPostgreSqlContainer;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await createGlobalUser(pool, { email: 'cookie@example.com', password: 'correct-password' });
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = container.getConnectionUri();

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('sets a host-only secure HttpOnly SameSite=Lax cookie with the opaque token, never the stored hash', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'cookie@example.com', password: 'correct-password' })
      .expect(204);

    const setCookie = response.headers['set-cookie'] as string[] | undefined;
    const cookie = setCookie?.[0];
    expect(cookie).toMatch(/^__Host-uco_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toMatch(/(?:^|;)\s*Domain=/i);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text ?? '').toBe('');

    const token = cookie?.split(';')[0]?.split('=')[1];
    expect(token).toBeDefined();
    const stored = await pool.query<{ token_hash: string }>('SELECT token_hash FROM auth_sessions');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.token_hash).toBe(createHash('sha256').update(token ?? '').digest('hex'));
    expect(cookie).not.toContain(stored.rows[0]?.token_hash ?? 'missing-hash');
  });

  it('returns the same problem and no cookie for unknown email or wrong password', async () => {
    const missing = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'missing@example.com', password: 'wrong-password' })
      .expect(401);
    const wrong = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'cookie@example.com', password: 'wrong-password' })
      .expect(401);

    expect(missing.headers['set-cookie']).toBeUndefined();
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect({ code: missing.body.code, detail: missing.body.detail, status: missing.body.status }).toEqual({
      code: wrong.body.code,
      detail: wrong.body.detail,
      status: wrong.body.status,
    });
  });
});
