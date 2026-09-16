import { randomBytes } from 'node:crypto';

import { context, SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import type { RequestCorrelation } from './logger.js';

const defaultOtlpEndpoint = 'http://localhost:4318';

export interface HttpSpanInput {
  readonly correlation: RequestCorrelation;
  readonly method: string;
  readonly route: string;
}

export const resolveOtlpTracesUrl = (endpoint: string | undefined): string => {
  const configuredEndpoint = endpoint ?? defaultOtlpEndpoint;
  return configuredEndpoint.endsWith('/v1/traces')
    ? configuredEndpoint
    : `${configuredEndpoint.replace(/\/$/, '')}/v1/traces`;
};

export const startOtlpTracing = (): (() => Promise<void>) => {
  const exporter = new OTLPTraceExporter({
    url: resolveOtlpTracesUrl(
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    ),
  });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'uconext-api',
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();

  return () => provider.shutdown();
};

export const startHttpSpan = (input: HttpSpanInput): Span => {
  const parent = trace.wrapSpanContext({
    isRemote: true,
    spanId: randomBytes(8).toString('hex'),
    traceFlags: 1,
    traceId: input.correlation.trace_id,
  });
  const parentContext = trace.setSpan(context.active(), parent);

  return trace.getTracer('uconext-api').startSpan(
    'http.server.request',
    {
      attributes: {
        'http.request.method': input.method,
        'http.route': input.route,
        'request.id': input.correlation.request_id,
      },
      kind: SpanKind.SERVER,
    },
    parentContext,
  );
};

export const finishHttpSpan = (span: Span, statusCode: number): void => {
  span.setAttribute('http.response.status_code', statusCode);
  if (statusCode >= 500) {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
};
