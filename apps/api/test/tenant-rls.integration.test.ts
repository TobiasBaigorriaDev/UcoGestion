import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';

const organizationA = '00000000-0000-4000-8000-000000000011';
const organizationB = '00000000-0000-4000-8000-000000000012';
const branchA = '00000000-0000-4000-8000-000000000013';
const branchB = '00000000-0000-4000-8000-000000000014';
const cashRegisterA = '00000000-0000-4000-8000-000000000015';
const cashRegisterB = '00000000-0000-4000-8000-000000000016';

describe('tenant RLS', () => {
  let client: Client;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();

    await client.query(
      "INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'America/Argentina/Mendoza'), ($2, 'ARS', 'America/Argentina/Mendoza')",
      [organizationA, organizationB],
    );
    await client.query(
      "INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Centro'), ($3, $4, 'Norte')",
      [branchA, organizationA, branchB, organizationB],
    );
    await client.query(
      "INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, 'Caja Centro'), ($4, $5, $6, 'Caja Norte')",
      [cashRegisterA, organizationA, branchA, cashRegisterB, organizationB, branchB],
    );
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('denies tenant rows without context and isolates a configured organization', async () => {
    await client.query('SET ROLE uco_app');

    try {
      const withoutContext = await client.query<{ id: string }>(
        'SELECT id FROM branches UNION ALL SELECT id FROM cash_registers',
      );

      expect(withoutContext.rows).toEqual([]);

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationA]);
      const scopedBranches = await client.query<{ id: string }>('SELECT id FROM branches');
      const scopedCashRegisters = await client.query<{ id: string }>('SELECT id FROM cash_registers');
      await client.query('COMMIT');

      expect(scopedBranches.rows).toEqual([{ id: branchA }]);
      expect(scopedCashRegisters.rows).toEqual([{ id: cashRegisterA }]);
    } finally {
      await client.query('RESET ROLE');
    }
  });
});
