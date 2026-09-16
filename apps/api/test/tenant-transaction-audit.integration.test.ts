import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantTransaction, type TenantAuditEvent } from '../src/database/tenant-transaction.js';
import { runMigrations } from '../src/database/migrate.js';

const organizationA = '00000000-0000-4000-8000-000000000051';
const organizationB = '00000000-0000-4000-8000-000000000052';
const branchA = '00000000-0000-4000-8000-000000000053';
const branchB = '00000000-0000-4000-8000-000000000054';
const actorUserId = '00000000-0000-4000-8000-000000000055';

describe('audited TenantTransaction', () => {
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
      "INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Centro'), ($3, $4, 'Norte')",
      [branchA, organizationA, branchB, organizationB],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('commits the business effect and mandatory audit event together', async () => {
    const transactions = new TenantTransaction(pool);
    const createdBranchId = '00000000-0000-4000-8000-000000000056';

    await transactions.run(
      { organizationId: organizationA, requestId: 'request-transaction-audit-1', userId: actorUserId },
      createAuditEvent(createdBranchId, null),
      async (client) => {
        await client.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Este')", [
          createdBranchId,
          organizationA,
        ]);
      },
    );

    expect(
      await pool.query('SELECT id FROM branches WHERE id = $1', [createdBranchId]),
    ).toMatchObject({ rows: [{ id: createdBranchId }] });
    expect(
      await pool.query<{ entity_id: string; organization_id: string }>(
        'SELECT entity_id, organization_id FROM audit_events WHERE entity_id = $1',
        [createdBranchId],
      ),
    ).toMatchObject({ rows: [{ entity_id: createdBranchId, organization_id: organizationA }] });
  });

  it('rolls back the business effect when the mandatory audit event cannot persist', async () => {
    const transactions = new TenantTransaction(pool);
    const rolledBackBranchId = '00000000-0000-4000-8000-000000000057';

    await expect(
      transactions.run(
        { organizationId: organizationA, requestId: 'request-transaction-audit-2', userId: actorUserId },
        createAuditEvent(rolledBackBranchId, branchB),
        async (client) => {
          await client.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Oeste')", [
            rolledBackBranchId,
            organizationA,
          ]);
        },
      ),
    ).rejects.toThrow();

    expect(await pool.query('SELECT id FROM branches WHERE id = $1', [rolledBackBranchId])).toMatchObject({
      rows: [],
    });
    expect(await pool.query('SELECT entity_id FROM audit_events WHERE entity_id = $1', [rolledBackBranchId])).toMatchObject({
      rows: [],
    });
  });
});

function createAuditEvent(entityId: string, branchId: string | null): TenantAuditEvent {
  return {
    action: 'branch.created',
    after: { name: 'Nueva sucursal' },
    afterAllowlist: ['name'],
    before: {},
    beforeAllowlist: [],
    branchId,
    context: { source: 'test' },
    contextAllowlist: ['source'],
    entityId,
    entityType: 'branch',
    operationId: `operation-${entityId}`,
  };
}
