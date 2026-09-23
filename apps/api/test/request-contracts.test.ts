import { BadRequestException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { createOpenApiDocument } from '../src/core/validation/openapi.js';
import {
  parseMasterListQuery,
  parseReceptionListQuery,
} from '../src/core/validation/master-list-query.js';
import {
  encodeCursor,
  parseCursorPageQuery,
} from '../src/core/validation/pagination.js';
import { ZodValidationPipe } from '../src/core/validation/zod-validation.pipe.js';

describe('request contracts', () => {
  it('validates and normalizes DTOs without exposing invalid input values', () => {
    const pipe = new ZodValidationPipe(
      z
        .object({
          name: z.string().trim().min(1),
        })
        .strict(),
    );

    expect(pipe.transform({ name: '  UcoNext  ' })).toEqual({ name: 'UcoNext' });

    try {
      pipe.transform({ name: '', password: 'must-not-appear' });
      throw new Error('Expected validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as Record<string, unknown>;
      expect(response).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(response).toHaveProperty('fieldErrors.name');
      expect(JSON.stringify(response)).not.toContain('must-not-appear');
    }
  });

  it('uses opaque cursors, bounded limits, and explicit filter allowlists', () => {
    const cursor = encodeCursor({
      id: '00000000-0000-4000-8000-000000000101',
      sortValue: '2026-09-16T00:00:00.000Z',
    });

    expect(
      parseCursorPageQuery(
        { cursor, limit: '25', status: 'ACTIVE' },
        ['status'],
      ),
    ).toEqual({
      cursor: {
        id: '00000000-0000-4000-8000-000000000101',
        sortValue: '2026-09-16T00:00:00.000Z',
      },
      filters: { status: 'ACTIVE' },
      limit: 25,
    });

    expect(() => parseCursorPageQuery({ limit: '101' }, [])).toThrow('limit');
    expect(() => parseCursorPageQuery({ owner: 'other-tenant' }, [])).toThrow('owner');
  });

  it('rejects malformed master-list filters before querying PostgreSQL', () => {
    expect(parseMasterListQuery({ limit: '25', status: 'ACTIVE' })).toEqual({
      limit: 25,
      status: 'ACTIVE',
    });
    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { limit: '2oops' },
      { status: 'ARCHIVED' },
      { unexpected: 'value' },
      { cursor: encodeCursor({ id: '00000000-0000-4000-8000-000000000101', sortValue: 'bad-date' }) },
      { cursor: encodeCursor({ id: '00000000-0000-4000-8000-000000000101', sortValue: '2026-02-31 00:00:00+00' }) },
    ]) {
      expect(() => parseMasterListQuery(query)).toThrow(BadRequestException);
    }
    expect(() => parseReceptionListQuery({ status: 'INACTIVE' })).toThrow(BadRequestException);
    expect(parseMasterListQuery({
      cursor: encodeCursor({
        id: '00000000-0000-4000-8000-000000000101',
        sortValue: '2026-09-23 05:30:00+05:30',
      }),
    }).cursor).toBeTruthy();
  });
});

describe('OpenAPI contract', () => {
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

  it('keeps a snapshot of the public API schema', () => {
    expect(createOpenApiDocument(app)).toMatchSnapshot();
  });
});
