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

describe('catalog lifecycle HTTP commands (T081A)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let userId: string;
  let previousDatabaseUrl: string | undefined;
  const organizationId = randomUUID();
  const itemId = randomUUID();
  const categoryId = randomUUID();
  const origin = 'http://localhost:3000';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const user = await createGlobalUser(pool, {
      email: 'catalog-lifecycle-e2e@example.com', password: 'correct-password',
    });
    userId = user.id;
    await pool.query(
      `INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'America/Argentina/Mendoza')`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')`,
      [randomUUID(), organizationId, user.id],
    );
    await pool.query(
      `INSERT INTO catalog_items (id, organization_id, name, type) VALUES ($1, $2, 'Lifecycle Item', 'PRODUCT')`,
      [itemId, organizationId],
    );
    await pool.query(
      `INSERT INTO catalog_categories (id, organization_id, name) VALUES ($1, $2, 'Lifecycle Category')`,
      [categoryId, organizationId],
    );
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

  it('exposes item and category lifecycle with session, CSRF, version and idempotency checks', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ email: 'catalog-lifecycle-e2e@example.com', password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf')
      .set('Cookie', cookie).expect(200);
    const patch = (path: string) => request(app.getHttpServer()).patch(path)
      .set('Origin', origin).set('Cookie', cookie)
      .set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string);
    const remove = (path: string) => request(app.getHttpServer()).delete(path)
      .set('Origin', origin).set('Cookie', cookie)
      .set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string)
      .set('Content-Type', 'application/json').send({});

    const categories = await request(app.getHttpServer()).get('/api/v1/catalog/categories')
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(categories.body.categories).toEqual([expect.objectContaining({
      id: categoryId, name: 'Lifecycle Category', status: 'ACTIVE', version: 1,
    })]);
    const createCategory = () => request(app.getHttpServer()).post('/api/v1/catalog/categories')
      .set('Origin', origin).set('Cookie', cookie)
      .set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string)
      .set('Idempotency-Key', 'category-create-key').send({ name: 'Almacén' });
    const created = await createCategory().expect(201);
    expect(created.body).toEqual(expect.objectContaining({ name: 'Almacén', status: 'ACTIVE', version: 1 }));
    expect((await createCategory().expect(201)).body).toEqual(created.body);

    const createItem = () => request(app.getHttpServer()).post('/api/v1/catalog/items')
      .set('Origin', origin).set('Cookie', cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string).set('Idempotency-Key', 'item-create-http-key')
      .send({ name: 'Yerba nueva', type: 'PRODUCT', trackInventory: true, baseUnit: 'UNIT', sku: 'Y-1', barcode: '12345' });
    const createdItem = await createItem().expect(201);
    expect(createdItem.body).toMatchObject({ name: 'Yerba nueva', trackInventory: true, version: 1 });
    expect((await createItem().expect(201)).body).toEqual(createdItem.body);
    const managed = await request(app.getHttpServer()).get('/api/v1/catalog/items/manage')
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(managed.body.items).toContainEqual(expect.objectContaining({ id: createdItem.body.id, sku: 'Y-1', version: 1 }));
    const edited = await patch(`/api/v1/catalog/items/${createdItem.body.id as string}`)
      .set('If-Match', '1').set('Idempotency-Key', 'item-edit-key')
      .send({ name: 'Yerba premium', sku: 'Y-2', barcode: '12346' }).expect(200);
    expect(edited.body).toMatchObject({ name: 'Yerba premium', sku: 'Y-2', version: 2 });
    const priced = await patch(`/api/v1/catalog/items/${createdItem.body.id as string}/price`)
      .set('If-Match', '2').set('Idempotency-Key', 'item-price-key')
      .send({ price: '150.00' }).expect(200);
    expect(priced.body).toMatchObject({ price: '150.00', priceVersion: 1, version: 3 });

    const itemStatus = `/api/v1/catalog/items/${itemId}/status`;
    const invalidStatus = await patch(itemStatus).set('If-Match', '1')
      .set('Idempotency-Key', 'invalid-status-key').send({ status: 'ARCHIVED' }).expect(400);
    expect(invalidStatus.body.code).toBe('VALIDATION_FAILED');
    await patch(itemStatus).set('If-Match', '1').send({ status: 'INACTIVE' }).expect(428);
    const first = await patch(itemStatus).set('If-Match', '1').set('Idempotency-Key', 'item-status-key')
      .send({ status: 'INACTIVE' }).expect(200);
    expect(first.body).toEqual(expect.objectContaining({ status: 'INACTIVE', version: 2 }));
    const replay = await patch(itemStatus).set('If-Match', '1').set('Idempotency-Key', 'item-status-key')
      .send({ status: 'INACTIVE' }).expect(200);
    expect(replay.body).toEqual(first.body);
    const structural = await patch(`/api/v1/catalog/items/${itemId}/structure`)
      .set('If-Match', '2').set('Idempotency-Key', 'item-structure-key')
      .send({ type: 'PRODUCT', baseUnit: 'FRACTIONAL' }).expect(200);
    expect(structural.body).toEqual(expect.objectContaining({ baseUnit: 'FRACTIONAL', version: 3 }));
    const category = await patch(`/api/v1/catalog/categories/${categoryId}/status`)
      .set('If-Match', '1').set('Idempotency-Key', 'category-status-key')
      .send({ status: 'INACTIVE' }).expect(200);
    expect(category.body.status).toBe('INACTIVE');
    await remove(`/api/v1/catalog/items/${itemId}`)
      .set('If-Match', '3').set('Idempotency-Key', 'item-delete-key').expect(200);
    await remove(`/api/v1/catalog/categories/${categoryId}`)
      .set('If-Match', '2').set('Idempotency-Key', 'category-delete-key').expect(200);

    const anotherItem = randomUUID();
    await pool.query(
      `INSERT INTO catalog_items (id, organization_id, name, type)
       VALUES ($1, $2, 'Permission Check', 'PRODUCT')`,
      [anotherItem, organizationId],
    );
    await pool.query(
      `UPDATE memberships SET role = 'CASHIER' WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
    const forbidden = await patch(`/api/v1/catalog/items/${anotherItem}/status`)
      .set('If-Match', '1').set('Idempotency-Key', 'cashier-status-key')
      .send({ status: 'INACTIVE' }).expect(403);
    expect(forbidden.body.code).toBe('CATALOG_ITEM_LIFECYCLE_FORBIDDEN');
    await request(app.getHttpServer()).get('/api/v1/catalog/categories')
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(403);
    await request(app.getHttpServer()).get('/api/v1/catalog/items/manage')
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).expect(403);
  });
});
