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
import { LoginService } from '../src/modules/auth/login.service.js';
import { SessionAuthenticationService } from '../src/modules/auth/session-authentication.service.js';
import { SessionRevocationService } from '../src/modules/auth/session-revocation.service.js';

describe('logout and session revocation', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let userId: string;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    userId = (await createGlobalUser(pool, {
      email: 'logout@example.com',
      password: 'correct-password',
    })).id;
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

  it('revokes only the presented token, clears its cookie, and preserves the session row', async () => {
    const login = new LoginService(pool);
    const first = await login.execute({ email: 'logout@example.com', password: 'correct-password' });
    const second = await login.execute({ email: 'logout@example.com', password: 'correct-password' });
    const firstHash = createHash('sha256').update(first.token).digest('hex');
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', `__Host-uco_session=${first.token}`)
      .expect(204);

    const setCookie = response.headers['set-cookie'] as string[] | undefined;
    expect(setCookie?.[0]).toMatch(/^__Host-uco_session=; Path=\/;.*Max-Age=0/);
    expect(setCookie?.[0]).toContain('Secure');
    expect(setCookie?.[0]).toContain('HttpOnly');
    expect(setCookie?.[0]).toContain('SameSite=Lax');
    expect(response.headers['cache-control']).toBe('no-store');
    const sessions = new SessionAuthenticationService(pool);
    expect(await sessions.authenticate(first.token)).toBeNull();
    expect(await sessions.authenticate(second.token)).toEqual({ userId });
    const persisted = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM auth_sessions WHERE token_hash = $1',
      [firstHash],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]?.revoked_at).toBeInstanceOf(Date);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', `__Host-uco_session=${first.token}`)
      .expect(204);
    await request(app.getHttpServer()).post('/api/v1/auth/logout').expect(204);
  });

  it('can revoke every session of one user without removing rows or affecting another user', async () => {
    const login = new LoginService(pool);
    const first = await login.execute({ email: 'logout@example.com', password: 'correct-password' });
    const second = await login.execute({ email: 'logout@example.com', password: 'correct-password' });
    const other = await createGlobalUser(pool, {
      email: 'other-logout@example.com',
      password: 'correct-password',
    });
    const otherSession = await login.execute({
      email: other.email,
      password: 'correct-password',
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE uco_app');
      await new SessionRevocationService(client).revokeAllForUser(userId);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const sessions = new SessionAuthenticationService(pool);
    expect(await sessions.authenticate(first.token)).toBeNull();
    expect(await sessions.authenticate(second.token)).toBeNull();
    expect(await sessions.authenticate(otherSession.token)).toEqual({ userId: other.id });
    const history = await pool.query<{ total: string; active: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE revoked_at IS NULL) AS active
       FROM auth_sessions WHERE user_id = $1`,
      [userId],
    );
    expect(Number(history.rows[0]?.total)).toBeGreaterThanOrEqual(4);
    expect(history.rows[0]?.active).toBe('0');
  });
});
