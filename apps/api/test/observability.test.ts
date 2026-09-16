import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createJsonLogger,
  createRequestCorrelation,
} from '../src/core/observability/logger.js';

describe('structured observability logging', () => {
  it('emits correlated JSON and removes secrets, credentials, and unnecessary PII', () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = createJsonLogger({ component: 'api' }, destination);

    logger.info(
      {
        device_id: 'device-1',
        email: 'operator@example.com',
        headers: {
          authorization: 'Bearer should-not-be-logged',
          cookie: '__Host-uco_session=secret',
        },
        password: 'not-a-password-to-log',
        request_id: 'request-123',
        token: 'not-a-token-to-log',
        trace_id: '0123456789abcdef0123456789abcdef',
        user_id: 'user-1',
      },
      'critical operation completed',
    );

    const entry = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(entry).toMatchObject({
      component: 'api',
      device_id: 'device-1',
      level: 30,
      msg: 'critical operation completed',
      request_id: 'request-123',
      trace_id: '0123456789abcdef0123456789abcdef',
      user_id: 'user-1',
    });
    expect(entry).not.toHaveProperty('password');
    expect(entry).not.toHaveProperty('token');
    expect(entry).not.toHaveProperty('email');
    expect(entry.headers).toEqual({});
  });

  it('uses valid inbound correlation IDs and generates safe replacements for malformed headers', () => {
    expect(
      createRequestCorrelation({
        'traceparent': '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
        'x-request-id': 'request-123',
      }),
    ).toEqual({
      request_id: 'request-123',
      trace_id: '0123456789abcdef0123456789abcdef',
    });

    const generated = createRequestCorrelation({
      'traceparent': 'not-a-traceparent',
      'x-request-id': 'request\nforged',
    });
    expect(generated.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });
});
