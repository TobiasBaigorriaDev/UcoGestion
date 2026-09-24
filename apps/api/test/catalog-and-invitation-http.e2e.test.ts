import { createHash, randomUUID } from 'node:crypto';

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

describe('catalog and invitation HTTP contracts', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let priorUrl: string | undefined;
  const organizationId = randomUUID();
  const branchId = randomUUID();
  const membershipId = randomUUID();
  const invitationId = randomUUID();
  const token = 'initial-invitation-token';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const owner = await createGlobalUser(pool, { email: 'contract-owner@example.com', password: 'correct-password' });
    await pool.query("INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'Contract tenant', 'ARS', 'UTC')", [organizationId]);
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Principal')", [branchId, organizationId]);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')", [membershipId, organizationId, owner.id]);
    await pool.query("INSERT INTO invitations (id, organization_id, email_normalized, role, token_hash, expires_at, invited_by_membership_id) VALUES ($1, $2, 'new-invitee@example.com', 'EMPLOYEE', $3, now() + interval '7 days', $4)", [invitationId, organizationId, createHash('sha256').update(token).digest('hex'), membershipId]);
    await pool.query('INSERT INTO invitation_branches (organization_id, invitation_id, branch_id) VALUES ($1, $2, $3)', [organizationId, invitationId, branchId]);
    await pool.query("INSERT INTO catalog_items (id, organization_id, name, type) VALUES ($1, $2, 'Visible', 'PRODUCT')", [randomUUID(), organizationId]);
    priorUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = container.getConnectionUri();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close(); await pool?.end(); await container?.stop();
    if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
  });

  it('keeps invitation links single-use through HTTP and returns no identifying detail for recovery', async () => {
    const forgot = await request(app.getHttpServer()).post('/api/v1/auth/forgot-password').set('Origin', 'http://localhost:3000').send({ email: 'unknown@example.com' }).expect(202);
    expect(forgot.body).toEqual({ accepted: true });
    const accepted = await request(app.getHttpServer()).post('/api/v1/auth/accept-invitation').set('Origin', 'http://localhost:3000').send({ token, password: 'new-invitee-password' }).expect(201);
    expect(accepted.body.organizationId).toBe(organizationId);
    await request(app.getHttpServer()).post('/api/v1/auth/accept-invitation').set('Origin', 'http://localhost:3000').send({ token, password: 'new-invitee-password' }).expect(400);
  });

  it('serves a safe read-only catalog to an authenticated tenant user', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000').send({ email: 'contract-owner@example.com', password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const catalog = await request(app.getHttpServer()).get('/api/v1/catalog/items').set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(catalog.body.items).toEqual([expect.objectContaining({ name: 'Visible', status: 'ACTIVE' })]);
    expect(JSON.stringify(catalog.body)).not.toMatch(/cost|margin/i);
  });

  it('exposes separate expense category management and active selection', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
      .send({ email: 'contract-owner@example.com', password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const headers = (verb: 'post' | 'patch' | 'delete', path: string) => request(app.getHttpServer())[verb](path)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', csrf.body.csrfToken as string);
    const created = await headers('post', '/api/v1/expense-categories').set('Idempotency-Key', 'expense-http-create')
      .send({ name: 'Servicios' }).expect(201);
    expect(created.body).toMatchObject({ name: 'Servicios', status: 'ACTIVE', version: 1 });
    const list = await request(app.getHttpServer()).get('/api/v1/expense-categories')
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(list.body.categories).toContainEqual(created.body);
    const inactive = await headers('patch', `/api/v1/expense-categories/${created.body.id as string}/status`)
      .set('Idempotency-Key', 'expense-http-status').set('If-Match', '1').send({ status: 'INACTIVE' }).expect(200);
    expect(inactive.body.status).toBe('INACTIVE');
    const active = await request(app.getHttpServer()).get('/api/v1/expense-categories/active')
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(active.body.categories).not.toContainEqual(inactive.body);
    await headers('delete', `/api/v1/expense-categories/${created.body.id as string}`)
      .set('Idempotency-Key', 'expense-http-delete').set('If-Match', '2').send({}).expect(200);
  });

  it('resends atomically, invalidates the old link and accepts an existing account once', async () => {
    const existing = await createGlobalUser(pool, { email: 'existing-invitee@example.com', password: 'correct-password' });
    const id = randomUUID();
    const oldToken = 'old-existing-token';
    await pool.query("INSERT INTO invitations (id, organization_id, email_normalized, role, token_hash, expires_at, invited_by_membership_id) VALUES ($1, $2, 'existing-invitee@example.com', 'EMPLOYEE', $3, now() + interval '7 days', $4)", [id, organizationId, createHash('sha256').update(oldToken).digest('hex'), membershipId]);
    await pool.query('INSERT INTO invitation_branches (organization_id, invitation_id, branch_id) VALUES ($1, $2, $3)', [organizationId, id, branchId]);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000').send({ email: 'contract-owner@example.com', password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const resend = () => request(app.getHttpServer()).post(`/api/v1/users/invitations/${id}/resend`).set('Origin', 'http://localhost:3000').set('Cookie', cookie).set('X-Organization-Id', organizationId).set('X-CSRF-Token', csrf.body.csrfToken as string).set('Idempotency-Key', 'resend-existing-http').send({});
    const first = await resend().expect(201);
    expect((await resend().expect(201)).body).toEqual(first.body);
    await request(app.getHttpServer()).post('/api/v1/auth/accept-invitation').set('Origin', 'http://localhost:3000').send({ token: oldToken }).expect(400);
    const job = await pool.query<{ payload: { token: string } }>("SELECT payload FROM outbox_jobs WHERE job_key LIKE $1 ORDER BY created_at DESC LIMIT 1", [`invitation-email:${id}:resend:%`]);
    const accepted = await request(app.getHttpServer()).post('/api/v1/auth/accept-invitation').set('Origin', 'http://localhost:3000').send({ token: job.rows[0]?.payload.token }).expect(201);
    expect(accepted.body).toMatchObject({ organizationId });
    expect((await pool.query('SELECT id FROM memberships WHERE organization_id = $1 AND user_id = $2', [organizationId, existing.id])).rowCount).toBe(1);
  });
});
