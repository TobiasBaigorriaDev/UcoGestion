import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';

describe('API bootstrap', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the API descriptor under /api/v1', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1').expect(200);

    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({
      service: 'uconext-api',
      version: 'v1',
    });
  });
});
