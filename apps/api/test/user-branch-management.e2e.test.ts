import { randomUUID } from 'node:crypto';

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

describe('user and branch management HTTP', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let previousDatabaseUrl: string | undefined;
  const organizationId = randomUUID();
  const branchId = randomUUID();
  const origin = 'http://localhost:3000';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const owner = await createGlobalUser(pool, { email: 'ui-owner@example.com', password: 'correct-password' });
    const admin = await createGlobalUser(pool, { email: 'ui-admin@example.com', password: 'correct-password' });
    await pool.query("INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'UI organization', 'ARS', 'America/Argentina/Mendoza')", [organizationId]);
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Principal')", [branchId, organizationId]);
    const adminMembershipId = randomUUID();
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'ADMIN')", [randomUUID(), organizationId, owner.id, adminMembershipId, admin.id]);
    await pool.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)', [organizationId, adminMembershipId, branchId]);
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = container.getConnectionUri();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close(); await pool?.end(); await container?.stop();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  async function session(email: string) {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin)
      .send({ email, password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    return { cookie, csrfToken: csrf.body.csrfToken as string };
  }

  it('lists branches, creates one once, and prevents ADMIN from creating branches or inviting OWNER', async () => {
    const owner = await session('ui-owner@example.com');
    const ownerGet = () => request(app.getHttpServer()).get('/api/v1/branches').set('Cookie', owner.cookie).set('X-Organization-Id', organizationId);
    expect((await ownerGet().expect(200)).body.branches).toEqual([expect.objectContaining({ id: branchId, name: 'Principal' })]);
    const post = () => request(app.getHttpServer()).post('/api/v1/branches').set('Origin', origin)
      .set('Cookie', owner.cookie).set('X-Organization-Id', organizationId).set('X-CSRF-Token', owner.csrfToken)
      .set('Idempotency-Key', 'branch-http-create');
    const first = await post().send({ name: 'Depósito' }).expect(201);
    expect(first.body).toMatchObject({ name: 'Depósito', status: 'ACTIVE' });
    expect((await post().send({ name: 'Depósito' }).expect(201)).body).toEqual(first.body);
    expect((await ownerGet().expect(200)).body.branches).toHaveLength(2);

    const admin = await session('ui-admin@example.com');
    expect((await request(app.getHttpServer()).get('/api/v1/branches').set('Cookie', admin.cookie)
      .set('X-Organization-Id', organizationId).expect(200)).body.branches).toEqual([expect.objectContaining({ id: branchId })]);
    await request(app.getHttpServer()).post('/api/v1/branches').set('Origin', origin)
      .set('Cookie', admin.cookie).set('X-Organization-Id', organizationId).set('X-CSRF-Token', admin.csrfToken)
      .set('Idempotency-Key', 'admin-branch-denied').send({ name: 'Otra' }).expect(403);
    expect((await request(app.getHttpServer()).get('/api/v1/users/management').set('Cookie', admin.cookie)
      .set('X-Organization-Id', organizationId).expect(200)).body.actorRole).toBe('ADMIN');
    await request(app.getHttpServer()).post('/api/v1/users/invitations').set('Origin', origin)
      .set('Cookie', admin.cookie).set('X-Organization-Id', organizationId).set('X-CSRF-Token', admin.csrfToken)
      .set('Idempotency-Key', 'admin-owner-denied').send({ email: 'new-owner@example.com', role: 'OWNER', branchIds: [] }).expect(403);
  });
});
