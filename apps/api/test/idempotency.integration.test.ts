import { Pool, type PoolClient } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  IdempotencyKeyReusedError,
  IdempotencyService,
  type IdempotencyRecord,
} from '../src/core/idempotency/idempotency.service.js';
import { runMigrations } from '../src/database/migrate.js';

const organizationId = '00000000-0000-4000-8000-000000000021';
const branchId = '00000000-0000-4000-8000-000000000022';
const actorUserId = '00000000-0000-4000-8000-000000000023';

describe('idempotency records', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });

    await pool.query(
      "INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'America/Argentina/Mendoza')",
      [organizationId],
    );
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Centro')", [
      branchId,
      organizationId,
    ]);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('replays only an authorized canonical request and rejects payload reuse', async () => {
    const request = {
      actorUserId,
      authorizationClass: 'BRANCH_OPERATOR',
      branchId,
      key: 'sale-0001',
      organizationId,
      payload: { lines: [{ itemId: 'item-1', quantity: '1.000' }], note: 'Venta mostrador' },
      scope: 'sales.confirm',
    };
    const authorizeReplay = vi.fn(async (record: IdempotencyRecord) => {
      expect(record.actorUserId).toBe(actorUserId);
      expect(record.authorizationClass).toBe('BRANCH_OPERATOR');
      expect(record.branchId).toBe(branchId);
    });

    const first = await runAsTenant(pool, async (client) => {
      const service = new IdempotencyService(client);
      const acquisition = await service.acquire(request, authorizeReplay);

      expect(acquisition.kind).toBe('acquired');
      if (acquisition.kind === 'acquired') {
        await service.complete(acquisition.record.id, {
          body: { operationId: '00000000-0000-4000-8000-000000000024' },
          statusCode: 201,
        });
      }

      return acquisition;
    });

    expect(first.kind).toBe('acquired');

    const replay = await runAsTenant(pool, async (client) => {
      const service = new IdempotencyService(client);
      return service.acquire(
        {
          ...request,
          payload: { note: 'Venta mostrador', lines: [{ quantity: '1.000', itemId: 'item-1' }] },
        },
        authorizeReplay,
      );
    });

    expect(replay).toMatchObject({
      kind: 'replay',
      response: { body: { operationId: '00000000-0000-4000-8000-000000000024' }, statusCode: 201 },
    });
    expect(authorizeReplay).toHaveBeenCalledTimes(1);

    const denyReplay = vi.fn(async () => {
      throw new Error('The actor no longer has permission for this branch.');
    });
    await expect(
      runAsTenant(pool, async (client) => {
        const service = new IdempotencyService(client);
        return service.acquire(request, denyReplay);
      }),
    ).rejects.toThrow('The actor no longer has permission for this branch.');
    expect(denyReplay).toHaveBeenCalledTimes(1);

    await expect(
      runAsTenant(pool, async (client) => {
        const service = new IdempotencyService(client);
        return service.acquire({ ...request, payload: { lines: [] } }, authorizeReplay);
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    expect(authorizeReplay).toHaveBeenCalledTimes(1);
  });
});

async function runAsTenant<TResult>(pool: Pool, operation: (client: PoolClient) => Promise<TResult>): Promise<TResult> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE uco_app');
    await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
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
