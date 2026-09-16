import { Pool, type PoolClient } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  IdempotencyReplayForbiddenError,
  IdempotencyService,
  type IdempotencyRequest,
} from '../src/core/idempotency/idempotency.service.js';
import { runMigrations } from '../src/database/migrate.js';

const organizationA = '00000000-0000-4000-8000-000000000031';
const organizationB = '00000000-0000-4000-8000-000000000032';
const branchA = '00000000-0000-4000-8000-000000000033';
const branchAOther = '00000000-0000-4000-8000-000000000034';
const branchB = '00000000-0000-4000-8000-000000000035';
const actorA = '00000000-0000-4000-8000-000000000036';
const actorOther = '00000000-0000-4000-8000-000000000037';

describe('idempotency concurrency and replay isolation', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });

    await pool.query(
      "INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'America/Argentina/Mendoza'), ($2, 'ARS', 'America/Argentina/Mendoza')",
      [organizationA, organizationB],
    );
    await pool.query(
      "INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Centro'), ($3, $4, 'Norte'), ($5, $6, 'Sur')",
      [branchA, organizationA, branchAOther, organizationA, branchB, organizationB],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('serializes two concurrent acquisitions into one completed record and one replay', async () => {
    const request = createRequest({ key: 'sale-concurrent-0001' });
    const firstClient = await beginTenantTransaction(pool, organizationA);
    const secondClient = await beginTenantTransaction(pool, organizationA);

    try {
      const firstService = new IdempotencyService(firstClient);
      const secondService = new IdempotencyService(secondClient);
      const first = await firstService.acquire(request, allowReplay);

      expect(first.kind).toBe('acquired');
      const secondAttempt = secondService.acquire(request, allowReplay);
      await expectRemainsPending(secondAttempt);

      if (first.kind === 'acquired') {
        await firstService.complete(first.record.id, {
          body: { operationId: '00000000-0000-4000-8000-000000000038' },
          statusCode: 201,
        });
      }
      await firstClient.query('COMMIT');

      const replay = await secondAttempt;
      expect(replay).toMatchObject({
        kind: 'replay',
        response: { body: { operationId: '00000000-0000-4000-8000-000000000038' }, statusCode: 201 },
      });
      await secondClient.query('COMMIT');

      const records = await pool.query<{ completed_records: string; total_records: string }>(
        `SELECT COUNT(*) FILTER (WHERE status = 'COMPLETED')::text AS completed_records, COUNT(*)::text AS total_records
        FROM idempotency_records
        WHERE organization_id = $1 AND scope = $2 AND key = $3`,
        [organizationA, request.scope, request.key],
      );
      expect(records.rows).toEqual([{ completed_records: '1', total_records: '1' }]);
    } finally {
      await rollbackIfOpen(firstClient);
      await rollbackIfOpen(secondClient);
      firstClient.release();
      secondClient.release();
    }
  });

  it('does not disclose a replay outside its actor, branch, tenant, or current permission', async () => {
    const request = createRequest({ key: 'sale-isolation-0001' });
    await completeRequest(pool, organizationA, request);

    await expect(
      runAsTenant(pool, organizationA, (client) =>
        new IdempotencyService(client).acquire({ ...request, actorUserId: actorOther }, allowReplay),
      ),
    ).rejects.toBeInstanceOf(IdempotencyReplayForbiddenError);

    await expect(
      runAsTenant(pool, organizationA, (client) =>
        new IdempotencyService(client).acquire({ ...request, branchId: branchAOther }, allowReplay),
      ),
    ).rejects.toBeInstanceOf(IdempotencyReplayForbiddenError);

    const deniedReplay = vi.fn(async () => {
      throw new Error('Permission revoked.');
    });
    await expect(
      runAsTenant(pool, organizationA, (client) => new IdempotencyService(client).acquire(request, deniedReplay)),
    ).rejects.toThrow('Permission revoked.');
    expect(deniedReplay).toHaveBeenCalledTimes(1);

    const anotherTenant = await runAsTenant(pool, organizationB, (client) =>
      new IdempotencyService(client).acquire(
        { ...request, branchId: branchB, organizationId: organizationB },
        allowReplay,
      ),
    );
    expect(anotherTenant.kind).toBe('acquired');
  });
});

const allowReplay = async (): Promise<void> => undefined;

function createRequest(overrides: Partial<IdempotencyRequest>): IdempotencyRequest {
  return {
    actorUserId: actorA,
    authorizationClass: 'BRANCH_OPERATOR',
    branchId: branchA,
    key: 'unused',
    organizationId: organizationA,
    payload: { lines: [{ itemId: 'item-1', quantity: '1.000' }] },
    scope: 'sales.confirm',
    ...overrides,
  };
}

async function completeRequest(pool: Pool, organizationId: string, request: IdempotencyRequest): Promise<void> {
  await runAsTenant(pool, organizationId, async (client) => {
    const service = new IdempotencyService(client);
    const acquired = await service.acquire(request, allowReplay);
    if (acquired.kind !== 'acquired') {
      throw new Error('The test setup expected an acquired idempotency record.');
    }
    await service.complete(acquired.record.id, { body: { accepted: true }, statusCode: 201 });
  });
}

async function beginTenantTransaction(pool: Pool, organizationId: string): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE uco_app');
  await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
  return client;
}

async function runAsTenant<TResult>(
  pool: Pool,
  organizationId: string,
  operation: (client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
  const client = await beginTenantTransaction(pool, organizationId);

  try {
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function expectRemainsPending(promise: Promise<unknown>): Promise<void> {
  const state = await Promise.race([
    promise.then(() => 'settled'),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
  ]);
  expect(state).toBe('pending');
}

async function rollbackIfOpen(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The transaction may have been committed by the test.
  }
}
