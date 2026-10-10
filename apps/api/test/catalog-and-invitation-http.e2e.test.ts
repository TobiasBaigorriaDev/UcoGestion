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
    await pool.query("CREATE ROLE catalog_http_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'catalog_http_runtime'; runtimeUrl.password = 'runtime-password';
    process.env.DATABASE_URL = runtimeUrl.toString();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close(); await pool?.end(); await container?.stop();
    if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
  });

  it.each(['CASHIER', 'EMPLOYEE'])('RF-49 revalidates %s membership and denies price changes over HTTP', async role => {
    const user = await createGlobalUser(pool, { email: `${role.toLowerCase()}-price@example.com`, password: 'correct-password' });
    const id = randomUUID();
    await pool.query('INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,$4)',
      [id, organizationId, user.id, role]);
    await pool.query('INSERT INTO membership_branches(organization_id,membership_id,branch_id) VALUES ($1,$2,$3)',
      [organizationId, id, branchId]);
    const item = (await pool.query<{ id: string }>('SELECT id FROM catalog_items WHERE organization_id=$1 LIMIT 1', [organizationId])).rows[0];
    if (!item) throw new Error('Missing catalog fixture');
    const before = (await pool.query('SELECT price,version,price_version FROM catalog_items WHERE id=$1', [item.id])).rows;
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
      .send({ email: `${role.toLowerCase()}-price@example.com`, password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    await request(app.getHttpServer()).patch(`/api/v1/catalog/items/${item.id}/price`)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string).set('Idempotency-Key', randomUUID()).set('If-Match', '1')
      .send({ price: '25.00' }).expect(403);
    expect((await pool.query('SELECT price,version,price_version FROM catalog_items WHERE id=$1', [item.id])).rows).toEqual(before);
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

  it('T236I: exposes versioned category editing with strict HTTP preconditions and replay', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
      .send({ email: 'contract-owner@example.com', password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const headers = (path: string) => request(app.getHttpServer()).patch(path)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string);
    const id = randomUUID();
    await pool.query("INSERT INTO catalog_categories(id,organization_id,name) VALUES ($1,$2,'Original HTTP')", [id, organizationId]);
    const path = `/api/v1/catalog/categories/${id}`;
    await headers(path).set('Idempotency-Key', randomUUID()).send({ name: 'Renombrada HTTP' }).expect(428);
    await headers(path).set('If-Match', '1').send({ name: 'Renombrada HTTP' }).expect(428);
    for (const body of [{ name: '' }, { name: 'X', organizationId: randomUUID() }, { name: 'X', status: 'INACTIVE' }]) {
      await headers(path).set('If-Match', '1').set('Idempotency-Key', randomUUID()).send(body).expect(400);
    }
    const key = randomUUID();
    const edited = await headers(path).set('If-Match', '1').set('Idempotency-Key', key).send({ name: 'Renombrada HTTP' }).expect(200);
    expect(edited.body).toEqual({ id, name: 'Renombrada HTTP', status: 'ACTIVE', version: 2 });
    const replay = await headers(path).set('If-Match', '1').set('Idempotency-Key', key).send({ name: 'Renombrada HTTP' }).expect(200);
    expect(replay.body).toEqual(edited.body);
    const conflict = await headers(path).set('If-Match', '1').set('Idempotency-Key', randomUUID()).send({ name: 'Otro' }).expect(409);
    expect(conflict.headers['content-type']).toContain('application/problem+json');
    expect(conflict.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2, traceId: expect.any(String) });
    expect((await pool.query("SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='catalog_category.updated'", [id])).rowCount).toBe(1);
  });

  it.each(['ADMIN', 'CASHIER', 'EMPLOYEE'])('T236I: authorizes %s category editing over real HTTP and rejects foreign IDs', async role => {
    const email = `category-http-${role.toLowerCase()}@example.com`;
    const actor = await createGlobalUser(pool, { email, password: 'correct-password' });
    const member = randomUUID();
    await pool.query('INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,$4)', [member, organizationId, actor.id, role]);
    await pool.query('INSERT INTO membership_branches(organization_id,membership_id,branch_id) VALUES ($1,$2,$3)', [organizationId, member, branchId]);
    const categoryId = randomUUID(), foreignId = randomUUID(), foreignOrg = randomUUID();
    await pool.query("INSERT INTO organizations(id,name,base_currency,timezone) VALUES ($1,'Other','ARS','UTC')", [foreignOrg]);
    await pool.query("INSERT INTO catalog_categories(id,organization_id,name) VALUES ($1,$2,'Editable'),($3,$4,'Foreign')", [categoryId, organizationId, foreignId, foreignOrg]);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
      .send({ email, password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const edit = (id: string, org: string) => request(app.getHttpServer()).patch(`/api/v1/catalog/categories/${id}`)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie).set('X-Organization-Id', org)
      .set('X-CSRF-Token', csrf.body.csrfToken as string).set('Idempotency-Key', randomUUID()).set('If-Match', '1').send({ name: 'Edited' });
    await edit(categoryId, organizationId).expect(role === 'ADMIN' ? 200 : 403);
    await edit(foreignId, organizationId).expect(role === 'ADMIN' ? 404 : 403);
    await edit(foreignId, foreignOrg).expect(403);
    expect((await pool.query('SELECT name,version FROM catalog_categories WHERE id=$1', [foreignId])).rows).toEqual([{ name: 'Foreign', version: '1' }]);
    expect((await pool.query('SELECT name,version FROM catalog_categories WHERE id=$1', [categoryId])).rows)
      .toEqual([{ name: role === 'ADMIN' ? 'Edited' : 'Editable', version: role === 'ADMIN' ? '2' : '1' }]);
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

  it('RF-246 rejects excess price scale over HTTP and permits zero with the same key', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
      .send({ email: 'contract-owner@example.com', password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const itemId = randomUUID();
    await pool.query("INSERT INTO catalog_items (id, organization_id, name, type) VALUES ($1, $2, 'Escala HTTP', 'PRODUCT')",
      [itemId, organizationId]);
    const key = randomUUID();
    const patch = () => request(app.getHttpServer()).patch(`/api/v1/catalog/items/${itemId}/price`)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', csrf.body.csrfToken as string)
      .set('Idempotency-Key', key).set('If-Match', '1');
    for (const price of ['10.005', '10.000', '-0.001']) {
      const rejected = await patch().send({ price }).expect(400);
      expect(rejected.headers['content-type']).toContain('application/problem+json');
      expect(rejected.body).toMatchObject({ code: 'CATALOG_PRICE_INVALID', traceId: expect.any(String) });
    }
    const accepted = await patch().send({ price: '0.00' }).expect(200);
    expect(accepted.body).toMatchObject({ price: '0.00', version: 2, priceVersion: 1 });
    expect((await patch().send({ price: '0.00' }).expect(200)).body).toEqual(accepted.body);
    expect((await pool.query('SELECT count(*)::integer AS n FROM catalog_price_versions WHERE item_id = $1',
      [itemId])).rows[0]?.n).toBe(1);
    expect((await pool.query("SELECT count(*)::integer AS n FROM audit_events WHERE entity_id = $1 AND action = 'catalog_item.price_changed'",
      [itemId])).rows[0]?.n).toBe(1);
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
