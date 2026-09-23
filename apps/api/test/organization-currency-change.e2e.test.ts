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

describe('PATCH /organizations/currency', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let organizationId: string;
  let userId: string;
  let previousDatabaseUrl: string | undefined;
  const origin = 'http://localhost:3000';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const user = await createGlobalUser(pool, {
      email: 'currency-e2e@example.com', password: 'correct-password',
    });
    userId = user.id;
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

  it('requires request preconditions, changes once, replays, and denies non-OWNER', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login').set('Origin', origin)
      .send({ email: 'currency-e2e@example.com', password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer())
      .get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const base = () => request(app.getHttpServer()).patch('/api/v1/organizations/currency')
      .set('Origin', origin).set('Cookie', cookie)
      .set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string);

    const missingVersion = await base().set('Idempotency-Key', 'e2e-currency-key')
      .send({ targetCurrency: 'USD' }).expect(428);
    expect(missingVersion.body.code).toBe('IF_MATCH_REQUIRED');
    const missingKey = await base().set('If-Match', '1')
      .send({ targetCurrency: 'USD' }).expect(428);
    expect(missingKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const first = await base().set('If-Match', '1').set('Idempotency-Key', 'e2e-currency-key')
      .send({ targetCurrency: 'usd' }).expect(200);
    expect(first.body).toEqual({ currency: 'USD', version: 2 });
    const replay = await base().set('If-Match', '1').set('Idempotency-Key', 'e2e-currency-key')
      .send({ targetCurrency: 'USD' }).expect(200);
    expect(replay.body).toEqual(first.body);
    const reused = await base().set('If-Match', '1').set('Idempotency-Key', 'e2e-currency-key')
      .send({ targetCurrency: 'EUR' }).expect(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    await pool.query("UPDATE memberships SET role = 'ADMIN' WHERE organization_id = $1 AND user_id = $2",
      [organizationId, userId]);
    const denied = await base().set('If-Match', '2').set('Idempotency-Key', 'e2e-currency-admin')
      .send({ targetCurrency: 'EUR' }).expect(403);
    expect(denied.body.code).toBe('CURRENCY_CHANGE_FORBIDDEN');
  });
});
