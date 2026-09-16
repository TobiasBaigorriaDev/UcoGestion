import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';

describe('database readiness', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = container.getConnectionUri();

    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();

    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it('reports ready only after PostgreSQL accepts a query', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);

    expect(response.body).toEqual({
      database: 'ready',
      status: 'ready',
    });
  });
});
