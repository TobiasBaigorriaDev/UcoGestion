import {
  Controller,
  HttpCode,
  HttpStatus,
  Put,
  Req,
  Res,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureApi } from '../src/configure-api.js';
import { MetricsService } from '../src/core/observability/metrics.service.js';
import {
  assertVersionMatch,
  executeOptimisticUpdate,
  IfMatchRequiredException,
  IfMatchVersion,
  InvalidIfMatchException,
  parseIfMatchVersion,
  VersionConflictException,
} from '../src/core/validation/if-match.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import {
  createConflictProblemDetails,
  problemDetailsContentType,
} from '../src/problem-details.js';

describe('If-Match strong version parsing and validation', () => {
  it('parses valid strong numeric and quoted entity tag versions into integers', () => {
    expect(parseIfMatchVersion('1')).toBe(1);
    expect(parseIfMatchVersion('"42"')).toBe(42);
    expect(parseIfMatchVersion('  "10"  ')).toBe(10);
    expect(parseIfMatchVersion(0)).toBe(0);
  });

  it('strictly rejects weak entity tags (W/...) because If-Match requires strong comparison (RFC 9110)', () => {
    const weakInputs = ['W/"7"', 'w/"7"', 'W/1', 'w/"42"', 'W/"100"'];
    for (const input of weakInputs) {
      expect(() => parseIfMatchVersion(input)).toThrowError(InvalidIfMatchException);
      try {
        parseIfMatchVersion(input);
      } catch (error) {
        const response = (error as InvalidIfMatchException).getResponse();
        expect(response).toMatchObject({
          code: 'INVALID_IF_MATCH',
          detail: 'El encabezado If-Match requiere comparación fuerte y no admite etiquetas débiles (W/).',
        });
      }
    }
  });

  it('returns undefined when header is absent and not required', () => {
    expect(parseIfMatchVersion(undefined, { required: false })).toBeUndefined();
    expect(parseIfMatchVersion(null, { required: false })).toBeUndefined();
  });

  it('throws an actionable 428 Precondition Required error when If-Match is missing and required', () => {
    expect(() => parseIfMatchVersion(undefined, { required: true })).toThrowError(IfMatchRequiredException);
    try {
      parseIfMatchVersion(undefined, { required: true });
    } catch (error) {
      const exception = error as IfMatchRequiredException;
      expect(exception.getStatus()).toBe(HttpStatus.PRECONDITION_REQUIRED);
      expect(exception.getResponse()).toMatchObject({
        code: 'IF_MATCH_REQUIRED',
        detail: 'El encabezado If-Match es requerido para modificar este recurso.',
      });
    }
  });

  it('rejects malformed, decimal, or negative If-Match headers without leaking internals', () => {
    const invalidInputs = ['abc', '-1', '1.5', '', 'W/', '"', 'null', 'undefined', '1, 2'];
    for (const input of invalidInputs) {
      expect(() => parseIfMatchVersion(input)).toThrowError(InvalidIfMatchException);
      try {
        parseIfMatchVersion(input);
      } catch (error) {
        const response = (error as InvalidIfMatchException).getResponse();
        expect(response).toMatchObject({
          code: 'INVALID_IF_MATCH',
        });
      }
    }
  });
});

describe('optimistic version assertion and conflict Problem Details', () => {
  it('passes cleanly when expected version matches current version', () => {
    expect(() => assertVersionMatch(3, 3)).not.toThrow();
  });

  it('throws VersionConflictException with safe current version when versions mismatch', () => {
    try {
      assertVersionMatch(1, 2, {
        currentTotal: '1250.00',
        detail: 'El recurso fue modificado por otra operación.',
        instance: '/api/v1/test-items/00000000-0000-4000-8000-000000000010',
      });
      throw new Error('Expected VersionConflictException');
    } catch (error) {
      expect(error).toBeInstanceOf(VersionConflictException);
      const conflict = error as VersionConflictException;
      expect(conflict.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(conflict.getResponse()).toMatchObject({
        code: 'VERSION_CONFLICT',
        currentTotal: '1250.00',
        currentVersion: 2,
        detail: 'El recurso fue modificado por otra operación.',
        instance: '/api/v1/test-items/00000000-0000-4000-8000-000000000010',
        title: 'Conflicto de concurrencia',
      });
    }
  });

  it('builds a compliant Problem Details conflict payload for application/problem+json', () => {
    const problem = createConflictProblemDetails({
      currentVersion: 4,
      detail: 'El registro fue actualizado por otra operación.',
      instance: '/api/v1/test-items/00000000-0000-4000-8000-000000000010',
      traceId: '0123456789abcdef0123456789abcdef',
    });

    expect(problem).toEqual({
      code: 'VERSION_CONFLICT',
      currentVersion: 4,
      detail: 'El registro fue actualizado por otra operación.',
      instance: '/api/v1/test-items/00000000-0000-4000-8000-000000000010',
      status: 409,
      title: 'Conflicto de concurrencia',
      traceId: '0123456789abcdef0123456789abcdef',
      type: 'about:blank',
    });
  });
});

describe('Real PostgreSQL TenantTransaction optimistic concurrency integration', () => {
  const organizationId = '00000000-0000-4000-8000-000000000001';
  const entityId = '00000000-0000-4000-8000-000000000010';
  const userId = '00000000-0000-4000-8000-000000000002';

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantTx: TenantTransaction;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    tenantTx = new TenantTransaction(pool);

    const client = await pool.connect();
    try {
      // Create test tables and audit structure matching project schema
      await client.query(`
        CREATE TABLE organizations (
          id uuid PRIMARY KEY,
          base_currency text NOT NULL,
          timezone text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE audit_events (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
          actor_user_id uuid NOT NULL,
          branch_id uuid,
          device_id uuid,
          request_id text NOT NULL,
          operation_id text NOT NULL,
          entity_type text NOT NULL,
          entity_id uuid NOT NULL,
          action text NOT NULL,
          before_data jsonb NOT NULL DEFAULT '{}'::jsonb,
          after_data jsonb NOT NULL DEFAULT '{}'::jsonb,
          context_data jsonb NOT NULL DEFAULT '{}'::jsonb,
          occurred_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE optimistic_test_records (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
          name text NOT NULL,
          version bigint NOT NULL DEFAULT 1,
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        ALTER TABLE optimistic_test_records ENABLE ROW LEVEL SECURITY;

        CREATE POLICY optimistic_test_records_isolation ON optimistic_test_records
          FOR ALL
          USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
          WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
      `);

      await client.query(
        "INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'America/Argentina/Mendoza')",
        [organizationId],
      );

      await client.query(
        "INSERT INTO optimistic_test_records (id, organization_id, name, version) VALUES ($1, $2, 'Original', 1)",
        [entityId, organizationId],
      );
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('updates row in PostgreSQL and increments version within TenantTransaction when expected version matches', async () => {
    const expectedVersion = 1;
    const newName = 'Actualizado Correctamente';

    const result = await tenantTx.run(
      {
        organizationId,
        requestId: 'req-001',
        userId,
      },
      {
        action: 'test_record.updated',
        after: { name: newName, version: 2 },
        afterAllowlist: ['name', 'version'],
        before: { name: 'Original', version: 1 },
        beforeAllowlist: ['name', 'version'],
        branchId: null,
        context: {},
        contextAllowlist: [],
        entityId,
        entityType: 'test_record',
        operationId: 'op-001',
      },
      async (client) => {
        return executeOptimisticUpdate({
          client,
          context: {
            instance: `/api/v1/test-records/${entityId}`,
          },
          expectedVersion,
          getCurrentVersion: async () => {
            const res = await client.query<{ version: string }>(
              'SELECT version FROM optimistic_test_records WHERE id = $1',
              [entityId],
            );
            return res.rows[0] ? Number(res.rows[0].version) : null;
          },
          update: async () => {
            const updateRes = await client.query<{ id: string; name: string; version: string }>(
              'UPDATE optimistic_test_records SET name = $1, version = version + 1 WHERE id = $2 AND version = $3 RETURNING id, name, version',
              [newName, entityId, expectedVersion],
            );
            return {
              result: updateRes.rows[0],
              rowCount: updateRes.rowCount,
            };
          },
        });
      },
    );

    expect(result).toMatchObject({
      id: entityId,
      name: 'Actualizado Correctamente',
      version: '2',
    });

    const verifyClient = await pool.connect();
    try {
      const row = await verifyClient.query<{ name: string; version: string }>(
        'SELECT name, version FROM optimistic_test_records WHERE id = $1',
        [entityId],
      );
      expect(row.rows[0]?.name).toBe('Actualizado Correctamente');
      expect(Number(row.rows[0]?.version)).toBe(2);
    } finally {
      verifyClient.release();
    }
  });

  it('fails with VersionConflictException (409) containing currentVersion and rolls back when version is outdated', async () => {
    const outdatedVersion = 1; // current is 2

    await expect(
      tenantTx.run(
        {
          organizationId,
          requestId: 'req-002',
          userId,
        },
        {
          action: 'test_record.updated',
          after: { name: 'Intento Conflicto' },
          afterAllowlist: ['name'],
          before: {},
          beforeAllowlist: [],
          branchId: null,
          context: {},
          contextAllowlist: [],
          entityId,
          entityType: 'test_record',
          operationId: 'op-002',
        },
        async (client) => {
          return executeOptimisticUpdate({
            client,
            context: {
              detail: 'El registro fue modificado por otra operación.',
              instance: `/api/v1/test-records/${entityId}`,
            },
            expectedVersion: outdatedVersion,
            getCurrentVersion: async () => {
              const res = await client.query<{ version: string }>(
                'SELECT version FROM optimistic_test_records WHERE id = $1',
                [entityId],
              );
              return res.rows[0] ? Number(res.rows[0].version) : null;
            },
            update: async () => {
              const updateRes = await client.query(
                'UPDATE optimistic_test_records SET name = $1, version = version + 1 WHERE id = $2 AND version = $3',
                ['Intento Conflicto', entityId, outdatedVersion],
              );
              return {
                result: updateRes.rows[0],
                rowCount: updateRes.rowCount,
              };
            },
          });
        },
      ),
    ).rejects.toThrow(VersionConflictException);

    // Verify database state remains unchanged
    const verifyClient = await pool.connect();
    try {
      const row = await verifyClient.query<{ name: string; version: string }>(
        'SELECT name, version FROM optimistic_test_records WHERE id = $1',
        [entityId],
      );
      expect(row.rows[0]?.name).toBe('Actualizado Correctamente');
      expect(Number(row.rows[0]?.version)).toBe(2);
    } finally {
      verifyClient.release();
    }
  });

  it('resolves concurrent updates with exactly one winner and one 409 conflict', async () => {
    // Current version is 2. Both concurrent requests read expectedVersion = 2.
    const concurrentAttempt1 = tenantTx.run(
      {
        organizationId,
        requestId: 'req-concurrent-1',
        userId,
      },
      {
        action: 'test_record.updated',
        after: { name: 'Worker 1' },
        afterAllowlist: ['name'],
        before: {},
        beforeAllowlist: [],
        branchId: null,
        context: {},
        contextAllowlist: [],
        entityId,
        entityType: 'test_record',
        operationId: 'op-c1',
      },
      async (client) => {
        return executeOptimisticUpdate({
          client,
          context: { instance: `/api/v1/test-records/${entityId}` },
          expectedVersion: 2,
          getCurrentVersion: async () => {
            const res = await client.query<{ version: string }>(
              'SELECT version FROM optimistic_test_records WHERE id = $1',
              [entityId],
            );
            return res.rows[0] ? Number(res.rows[0].version) : null;
          },
          update: async () => {
            const updateRes = await client.query<{ id: string; name: string; version: string }>(
              'UPDATE optimistic_test_records SET name = $1, version = version + 1 WHERE id = $2 AND version = $3 RETURNING id, name, version',
              ['Worker 1', entityId, 2],
            );
            return {
              result: updateRes.rows[0],
              rowCount: updateRes.rowCount,
            };
          },
        });
      },
    );

    const concurrentAttempt2 = tenantTx.run(
      {
        organizationId,
        requestId: 'req-concurrent-2',
        userId,
      },
      {
        action: 'test_record.updated',
        after: { name: 'Worker 2' },
        afterAllowlist: ['name'],
        before: {},
        beforeAllowlist: [],
        branchId: null,
        context: {},
        contextAllowlist: [],
        entityId,
        entityType: 'test_record',
        operationId: 'op-c2',
      },
      async (client) => {
        return executeOptimisticUpdate({
          client,
          context: { instance: `/api/v1/test-records/${entityId}` },
          expectedVersion: 2,
          getCurrentVersion: async () => {
            const res = await client.query<{ version: string }>(
              'SELECT version FROM optimistic_test_records WHERE id = $1',
              [entityId],
            );
            return res.rows[0] ? Number(res.rows[0].version) : null;
          },
          update: async () => {
            const updateRes = await client.query<{ id: string; name: string; version: string }>(
              'UPDATE optimistic_test_records SET name = $1, version = version + 1 WHERE id = $2 AND version = $3 RETURNING id, name, version',
              ['Worker 2', entityId, 2],
            );
            return {
              result: updateRes.rows[0],
              rowCount: updateRes.rowCount,
            };
          },
        });
      },
    );

    const results = await Promise.allSettled([concurrentAttempt1, concurrentAttempt2]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const failureReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(failureReason).toBeInstanceOf(VersionConflictException);
    expect(failureReason.currentVersion).toBe(3);

    // Verify DB reached version 3
    const verifyClient = await pool.connect();
    try {
      const row = await verifyClient.query<{ version: string }>(
        'SELECT version FROM optimistic_test_records WHERE id = $1',
        [entityId],
      );
      expect(Number(row.rows[0]?.version)).toBe(3);
    } finally {
      verifyClient.release();
    }
  });
});

describe('HTTP E2E If-Match pipeline and ProblemDetailsExceptionFilter', () => {
  let app: INestApplication;
  let currentResourceVersion = 5;

  @Controller('test-resource')
  class TestResourceController {
    @Put(':id')
    @HttpCode(HttpStatus.OK)
    update(
      @IfMatchVersion({ required: true }) ifMatchVersion: number,
      @Req() req: { originalUrl?: string; params: { id?: string } },
      @Res() res: { json: (body: unknown) => void; setHeader: (name: string, value: string) => void },
    ) {
      if (ifMatchVersion !== currentResourceVersion) {
        throw new VersionConflictException({
          currentVersion: currentResourceVersion,
          detail: 'El recurso fue modificado por otra operación.',
          instance: req.originalUrl,
        });
      }
      currentResourceVersion += 1;
      res.setHeader('ETag', `"${currentResourceVersion}"`);
      return res.json({
        id: req.params.id,
        version: currentResourceVersion,
      });
    }
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TestResourceController],
      providers: [MetricsService],
    }).compile();

    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('responds with 200 and updated ETag when valid strong If-Match matches', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/v1/test-resource/item-1')
      .set('if-match', '"5"')
      .expect(200);

    expect(response.headers.etag).toBe('"6"');
    expect(response.body).toEqual({
      id: 'item-1',
      version: 6,
    });
  });

  it('responds with 409 Conflict Problem Details with currentVersion when strong If-Match is outdated', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/v1/test-resource/item-1')
      .set('if-match', '"5"')
      .set('traceparent', '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01')
      .expect(409);

    expect(response.headers['content-type']).toContain(problemDetailsContentType);
    expect(response.body).toMatchObject({
      code: 'VERSION_CONFLICT',
      currentVersion: 6,
      detail: 'El recurso fue modificado por otra operación.',
      instance: '/api/v1/test-resource/item-1',
      status: 409,
      title: 'Conflicto de concurrencia',
      traceId: '0123456789abcdef0123456789abcdef',
      type: 'about:blank',
    });
  });

  it('strictly rejects weak If-Match (W/...) with 400 Bad Request Problem Details', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/v1/test-resource/item-1')
      .set('if-match', 'W/"6"')
      .expect(400);

    expect(response.headers['content-type']).toContain(problemDetailsContentType);
    expect(response.body).toMatchObject({
      code: 'INVALID_IF_MATCH',
      detail: 'El encabezado If-Match requiere comparación fuerte y no admite etiquetas débiles (W/).',
      status: 400,
      title: 'Encabezado inválido',
      type: 'about:blank',
    });
  });

  it('rejects missing If-Match with 428 Precondition Required Problem Details', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/v1/test-resource/item-1')
      .expect(428);

    expect(response.headers['content-type']).toContain(problemDetailsContentType);
    expect(response.body).toMatchObject({
      code: 'IF_MATCH_REQUIRED',
      detail: 'El encabezado If-Match es requerido para modificar este recurso.',
      status: 428,
      title: 'Precondición requerida',
      type: 'about:blank',
    });
  });
});
