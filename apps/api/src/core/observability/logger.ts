import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';

export interface LogContext {
  readonly component: string;
  readonly device_id?: string;
  readonly request_id?: string;
  readonly tenant_id?: string;
  readonly trace_id?: string;
  readonly user_id?: string;
}

export interface RequestCorrelation {
  readonly request_id: string;
  readonly trace_id: string;
}

const inboundRequestId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const traceparent = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;

const redactedPaths = [
  'authorization',
  'cookie',
  'email',
  'headers.authorization',
  'headers.cookie',
  'headers.x-api-key',
  'headers.x-csrf-token',
  'password',
  'passwordHash',
  'password_hash',
  'refreshToken',
  'refresh_token',
  'token',
];

const sensitiveFieldNames = new Set(
  redactedPaths
    .filter((path) => !path.includes('.'))
    .map((path) => normalizeFieldName(path)),
);

export const createJsonLogger = (context: LogContext, destination?: DestinationStream): Logger =>
  pino(
    {
      base: context,
      formatters: {
        log: (object) => removeSensitiveFields(object),
      },
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: redactedPaths,
        remove: true,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );

export const createRequestCorrelation = (headers: IncomingHttpHeaders): RequestCorrelation => {
  const requestId = headerValue(headers, 'x-request-id');
  const traceparentValue = headerValue(headers, 'traceparent');
  const traceparentMatch = traceparentValue?.match(traceparent);

  return {
    request_id: requestId && inboundRequestId.test(requestId) ? requestId : randomUUID(),
    trace_id: traceparentMatch?.[1]?.toLowerCase() ?? randomBytes(16).toString('hex'),
  };
};

export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.info(nestContext(optionalParams), normalizeMessage(message));
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error(nestContext(optionalParams), normalizeMessage(message));
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.warn(nestContext(optionalParams), normalizeMessage(message));
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug(nestContext(optionalParams), normalizeMessage(message));
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.trace(nestContext(optionalParams), normalizeMessage(message));
  }
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function nestContext(optionalParams: unknown[]): Record<string, string> {
  const context = optionalParams.findLast((parameter) => typeof parameter === 'string');
  return typeof context === 'string' ? { context } : {};
}

function normalizeMessage(message: unknown): string {
  return message instanceof Error ? message.message : String(message);
}

function normalizeFieldName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function removeSensitiveFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitiveFieldNames.has(normalizeFieldName(key)))
      .map(([key, fieldValue]) => [key, redactNestedValue(fieldValue)]),
  );
}

function redactNestedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactNestedValue);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitiveFieldNames.has(normalizeFieldName(key)))
      .map(([key, fieldValue]) => [key, redactNestedValue(fieldValue)]),
  );
}
