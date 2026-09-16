import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { resolveOtlpTracesUrl } from '../src/core/observability/tracing.js';

describe('operational observability', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('keeps liveness independent from dependencies and exposes bounded Prometheus HTTP metrics', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .expect(200)
      .expect({ status: 'live' });

    const metrics = await request(app.getHttpServer())
      .get('/api/v1/metrics')
      .expect(200);

    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.text).toContain('# HELP uconext_http_requests_total');
    expect(metrics.text).toContain('uconext_http_request_duration_seconds');
    expect(metrics.text).toContain('route="/api/v1/health/live"');
  });

  it('normalizes the OTLP traces endpoint for the configured collector', () => {
    expect(resolveOtlpTracesUrl('http://otel-collector:4318')).toBe(
      'http://otel-collector:4318/v1/traces',
    );
    expect(resolveOtlpTracesUrl('http://collector:4318/v1/traces')).toBe(
      'http://collector:4318/v1/traces',
    );
  });
});
