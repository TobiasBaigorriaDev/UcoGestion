import type { INestApplication } from '@nestjs/common';

import {
  createJsonLogger,
  createRequestCorrelation,
  type LogContext,
} from './core/observability/logger.js';
import { MetricsService } from './core/observability/metrics.service.js';
import { finishHttpSpan, startHttpSpan } from './core/observability/tracing.js';

export const apiPrefix = 'api/v1';

interface HttpRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly method?: string;
  readonly originalUrl?: string;
}

interface HttpResponse {
  readonly statusCode: number;
  once(event: 'finish', listener: () => void): void;
  setHeader(name: string, value: string): void;
}

interface ConfigureApiOptions {
  readonly logger?: ReturnType<typeof createJsonLogger>;
}

export const configureApi = (app: INestApplication, options: ConfigureApiOptions = {}): INestApplication => {
  const logger = options.logger ?? createJsonLogger({ component: 'api' });
  const metrics = app.get(MetricsService);
  app.setGlobalPrefix(apiPrefix);
  app.use((request: HttpRequest, response: HttpResponse, next: () => void) => {
    const correlation = createRequestCorrelation(request.headers);
    const startedAt = performance.now();
    const route = metricRoute(request.originalUrl);
    const span = startHttpSpan({
      correlation,
      method: request.method ?? 'UNKNOWN',
      route,
    });
    response.setHeader('x-request-id', correlation.request_id);
    response.once('finish', () => {
      const durationMs = performance.now() - startedAt;
      metrics.recordHttpRequest({
        durationMs,
        method: request.method ?? 'UNKNOWN',
        route,
        statusCode: response.statusCode,
      });
      finishHttpSpan(span, response.statusCode);
      const context: Omit<LogContext, 'component'> & Record<string, number | string | undefined> = {
        duration_ms: durationMs,
        method: request.method,
        path: request.originalUrl,
        request_id: correlation.request_id,
        status_code: response.statusCode,
        trace_id: correlation.trace_id,
      };
      logger.info(context, 'http request completed');
    });
    next();
  });
  return app;
};

function metricRoute(url: string | undefined): string {
  const path = url?.split('?')[0];
  if (path === `/${apiPrefix}/health/live` || path === `/${apiPrefix}/health/ready` || path === `/${apiPrefix}/metrics`) {
    return path;
  }
  return `/${apiPrefix}/other`;
}
