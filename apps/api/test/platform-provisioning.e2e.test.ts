import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { LoginService } from '../src/modules/auth/login.service.js';

describe('platform provisioning HTTP API', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let previousDatabaseUrl: string | undefined;
  let previousPlatformDatabaseUrl: string | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousPlatformDatabaseUrl = process.env.PLATFORM_DATABASE_URL;
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.PLATFORM_DATABASE_URL = container.getConnectionUri();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    process.env.DATABASE_URL = previousDatabaseUrl;
    process.env.PLATFORM_DATABASE_URL = previousPlatformDatabaseUrl;
    await container?.stop();
  });

  it('exposes provisioning only to an authenticated active platform administrator', async () => {
    const admin = await createGlobalUser(pool, { email: 'platform-http@example.com', password: 'platform-password' });
    await pool.query("INSERT INTO platform_admins (user_id, status) VALUES ($1, 'ACTIVE')", [admin.id]);
    const token = (await new LoginService(pool).execute({ email: admin.email, password: 'platform-password' })).token;
    const csrf = await request(app.getHttpServer())
      .get('/api/v1/auth/csrf')
      .set('Cookie', `__Host-uco_session=${token}`)
      .expect(200);

    const created = await request(app.getHttpServer())
      .post('/api/v1/platform/organizations')
      .set('Cookie', `__Host-uco_session=${token}`)
      .set('X-CSRF-Token', csrf.body.csrfToken as string)
      .set('Origin', 'http://localhost:3000')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('Content-Type', 'application/json')
      .send({
        firstBranchName: 'Central',
        organizationName: 'HTTP Organization',
        ownerEmail: 'http-owner@example.com',
        ownerPassword: 'a-secure-owner-password',
        requestId: 'platform-http-001',
        timezone: 'America/Argentina/Buenos_Aires',
      })
      .expect(201);

    expect(created.body).toMatchObject({
      branchId: expect.any(String),
      membershipId: expect.any(String),
      organizationId: expect.any(String),
      userId: expect.any(String),
    });

    const ordinary = await createGlobalUser(pool, { email: 'ordinary@example.com', password: 'ordinary-password' });
    const ordinaryToken = (await new LoginService(pool).execute({ email: ordinary.email, password: 'ordinary-password' })).token;
    const ordinaryCsrf = await request(app.getHttpServer())
      .get('/api/v1/auth/csrf')
      .set('Cookie', `__Host-uco_session=${ordinaryToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/platform/organizations')
      .set('Cookie', `__Host-uco_session=${ordinaryToken}`)
      .set('X-CSRF-Token', ordinaryCsrf.body.csrfToken as string)
      .set('Origin', 'http://localhost:3000')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('Content-Type', 'application/json')
      .send({
        firstBranchName: 'Central',
        organizationName: 'Denied Organization',
        ownerEmail: 'denied-owner@example.com',
        ownerPassword: 'a-secure-owner-password',
        requestId: 'platform-http-denied-001',
        timezone: 'America/Argentina/Buenos_Aires',
      })
      .expect(403);
  });
});
