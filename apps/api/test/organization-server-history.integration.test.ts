import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { OrganizationCurrencyChangePolicy } from '../src/modules/organizations/organization-currency-change.policy.js';
import {
  OrganizationHistoryScopeError,
  PostgresServerHistoryPredicate,
} from '../src/modules/organizations/server-history.predicate.js';

describe('organization server-history predicate', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let predicate: PostgresServerHistoryPredicate;
  let currencyPolicy: OrganizationCurrencyChangePolicy;
  let organizationA: string;
  let organizationB: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    predicate = new PostgresServerHistoryPredicate();
    currencyPolicy = new OrganizationCurrencyChangePolicy();
    organizationA = randomUUID();
    organizationB = randomUUID();
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'History A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'History B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  async function inTenant<TResult>(
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

  it('turns true at the first server reference and never clears after void or reversal', async () => {
    await expect(inTenant(organizationA, (client) => predicate.lockAndCheck(client, organizationA)))
      .resolves.toBe(false);

    const saleId = randomUUID();
    await inTenant(organizationA, (client) => client.query(
      `INSERT INTO organization_history_references
         (id, organization_id, reference_domain, reference_type, source_id)
       VALUES ($1, $2, 'COMMERCIAL', 'SALE', $3)`,
      [randomUUID(), organizationA, saleId],
    ));
    const firstMarker = await pool.query<{ operational_history_started_at: Date }>(
      'SELECT operational_history_started_at FROM organizations WHERE id = $1',
      [organizationA],
    );

    await inTenant(organizationA, (client) => client.query(
      `INSERT INTO organization_history_references
         (id, organization_id, reference_domain, reference_type, source_id)
       VALUES ($1, $2, 'COMMERCIAL', 'SALE_VOID', $3),
              ($4, $2, 'MONETARY', 'SALE_REVERSAL', $5)`,
      [randomUUID(), organizationA, saleId, randomUUID(), randomUUID()],
    ));

    await expect(pool.query(
      'DELETE FROM organization_history_references WHERE organization_id = $1 AND source_id = $2',
      [organizationA, saleId],
    )).rejects.toThrow(/append-only/i);
    const hasHistory = await inTenant(
      organizationA,
      (client) => predicate.lockAndCheck(client, organizationA),
    );
    expect(hasHistory).toBe(true);
    expect(() => currencyPolicy.authorize({ actorRole: 'OWNER', hasServerHistory: hasHistory, targetCurrency: 'USD' }))
      .toThrow(expect.objectContaining({ code: 'CURRENCY_LOCKED_BY_HISTORY' }));

    const afterReversal = await pool.query<{ operational_history_started_at: Date }>(
      'SELECT operational_history_started_at FROM organizations WHERE id = $1',
      [organizationA],
    );
    expect(afterReversal.rows[0]?.operational_history_started_at.toISOString())
      .toBe(firstMarker.rows[0]?.operational_history_started_at.toISOString());
  });

  it('keeps tenant isolation and leaves unrelated organizations unlocked', async () => {
    await expect(inTenant(organizationB, (client) => predicate.lockAndCheck(client, organizationB)))
      .resolves.toBe(false);
    await expect(inTenant(organizationB, (client) => predicate.lockAndCheck(client, organizationA)))
      .rejects.toBeInstanceOf(OrganizationHistoryScopeError);
  });

  it.each(['COMMERCIAL', 'MONETARY', 'INVENTORY'] as const)(
    'marks history when the first reference belongs to the %s domain',
    async (referenceDomain) => {
      const organizationId = randomUUID();
      await pool.query(
        "INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'Domain Org', 'ARS', 'UTC')",
        [organizationId],
      );
      await inTenant(organizationId, (client) => client.query(
        `INSERT INTO organization_history_references
           (id, organization_id, reference_domain, reference_type, source_id)
         VALUES ($1, $2, $3, 'FIRST_REFERENCE', $4)`,
        [randomUUID(), organizationId, referenceDomain, randomUUID()],
      ));
      await expect(inTenant(organizationId, (client) => predicate.lockAndCheck(client, organizationId)))
        .resolves.toBe(true);
    },
  );
});
