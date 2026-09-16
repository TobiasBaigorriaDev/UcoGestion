import type { INestApplication } from '@nestjs/common';

import {
  createJsonLogger,
  createRequestCorrelation,
  type LogContext,
} from './core/observability/logger.js';
import { MetricsService } from './core/observability/metrics.service.js';
import { finishHttpSpan, startHttpSpan } from './core/observability/tracing.js';

import { createSecurityHeaders } from './core/security/security-headers.js';
import { ProblemDetailsExceptionFilter } from './problem-details.js';

export const apiPrefix = 'api/v1';

interface HttpRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly method?: string;
  readonly originalUrl?: string;
  readonly socket?: {
    readonly encrypted?: boolean | undefined;
    readonly remoteAddress?: string | undefined;
  } | undefined;
  readonly url?: string;
}

interface HttpResponse {
  end?: (chunk?: unknown) => void;
  readonly statusCode: number;
  once(event: 'finish', listener: () => void): void;
  setHeader(name: string, value: string): void;
  writeHead?(statusCode: number, headers?: Record<string, string>): void;
}

interface ConfigureApiOptions {
  readonly logger?: ReturnType<typeof createJsonLogger>;
  readonly publicApiOrigin?: string | undefined;
  readonly trustedProxyIps?: readonly string[] | undefined;
}

export const configureApi = (app: INestApplication, options: ConfigureApiOptions = {}): INestApplication => {
  const logger = options.logger ?? createJsonLogger({ component: 'api' });
  const metrics = app.get(MetricsService);
  const securityHeaders = createSecurityHeaders({ isApi: true });
  const publicApiOrigin = resolvePublicApiOrigin(options.publicApiOrigin);
  const trustedProxyIps = options.trustedProxyIps ?? parseTrustedProxyIps();

  app.setGlobalPrefix(apiPrefix);
  app.useGlobalFilters(new ProblemDetailsExceptionFilter());
  app.use((request: HttpRequest, response: HttpResponse, next: () => void) => {
    for (const [header, value] of Object.entries(securityHeaders)) {
      response.setHeader(header, value);
    }

    if (publicApiOrigin.protocol === 'https:' && !isSecureRequest(request, trustedProxyIps)) {
      const targetPath = request.originalUrl ?? request.url ?? '/';
      const httpsUrl = new URL(targetPath, publicApiOrigin).toString();

      if (typeof response.writeHead === 'function' && typeof response.end === 'function') {
        response.writeHead(308, { Location: httpsUrl });
        response.end();
        return;
      }
      response.setHeader('Location', httpsUrl);
      return;
    }

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

function resolvePublicApiOrigin(configuredOrigin: string | undefined): URL {
  const origin = configuredOrigin ?? process.env.UCONEXT_PUBLIC_API_ORIGIN;
  if (origin === undefined && process.env.NODE_ENV === 'production') {
    throw new Error('UCONEXT_PUBLIC_API_ORIGIN is required in production.');
  }

  const parsed = new URL(origin ?? 'http://localhost:3000');
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('UCONEXT_PUBLIC_API_ORIGIN must be an origin without a path, query, or hash.');
  }
  return parsed;
}

function parseTrustedProxyIps(): readonly string[] {
  return (process.env.UCONEXT_TRUSTED_PROXY_IPS ?? '')
    .split(',')
    .map((address) => normalizeAddress(address))
    .filter((address) => address.length > 0);
}

function isSecureRequest(request: HttpRequest, trustedProxyIps: readonly string[]): boolean {
  if (request.socket?.encrypted === true) {
    return true;
  }

  const remoteAddress = normalizeAddress(request.socket?.remoteAddress ?? '');
  if (!trustedProxyIps.includes(remoteAddress)) {
    return false;
  }

  const forwardedProto = request.headers['x-forwarded-proto'];
  const rawProto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return rawProto?.split(',')[0]?.trim().toLowerCase() === 'https';
}

function normalizeAddress(address: string): string {
  const normalized = address.trim().toLowerCase();
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
}
