import { Pool, type PoolClient } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditEventWriter } from '../src/core/audit/audit-event-writer.js';
import { runMigrations } from '../src/database/migrate.js';

const organizationA = '00000000-0000-4000-8000-000000000041';
const organizationB = '00000000-0000-4000-8000-000000000042';
const branchA = '00000000-0000-4000-8000-000000000043';
const actorUserId = '00000000-0000-4000-8000-000000000044';

describe('audit events', () => {
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
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Centro')", [
      branchA,
      organizationA,
    ]);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('persists only allowlisted non-sensitive audit context and denies cross-tenant reads', async () => {
    const event = await runAsTenant(pool, organizationA, async (client) => {
      const writer = new AuditEventWriter(client);
      return writer.append({
        action: 'branch.updated',
        actorUserId,
        after: { name: 'Centro actualizado', passwordHash: 'never-store-this' },
        afterAllowlist: ['name', 'passwordHash'],
        before: { name: 'Centro', passwordHash: 'never-store-this' },
        beforeAllowlist: ['name', 'passwordHash'],
        branchId: branchA,
        context: { source: 'api', token: 'never-store-this' },
        contextAllowlist: ['source', 'token'],
        entityId: branchA,
        entityType: 'branch',
        operationId: 'operation-0001',
        organizationId: organizationA,
        requestId: 'request-0001',
      });
    });

    expect(event).toMatchObject({
      action: 'branch.updated',
      after: { name: 'Centro actualizado' },
      before: { name: 'Centro' },
      context: { source: 'api' },
      organizationId: organizationA,
    });

    const visibleFromAnotherTenant = await runAsTenant(pool, organizationB, (client) =>
      client.query('SELECT id FROM audit_events'),
    );
    expect(visibleFromAnotherTenant.rows).toEqual([]);
  });

  it('rejects database updates and deletes even for the table owner', async () => {
    await expect(pool.query("UPDATE audit_events SET action = 'tampered'")).rejects.toThrow(
      'audit_events are append-only',
    );
    await expect(pool.query('DELETE FROM audit_events')).rejects.toThrow('audit_events are append-only');
  });
});

async function runAsTenant<TResult>(
  pool: Pool,
  organizationId: string,
  operation: (client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
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
