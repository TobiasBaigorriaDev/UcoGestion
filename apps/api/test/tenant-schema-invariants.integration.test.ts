import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';

/**
 * CHECK-02: tenant invariants over the effective schema produced by every
 * migration, not over historical declarations. New tables are covered
 * automatically.
 */
describe('T236K8 effective tenant schema invariants', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => { await pool?.end(); await container?.stop(); });

  it('enables RLS on every table with organization_id and gives runtime-accessible ones a policy', async () => {
    const result = await pool.query<{ table: string; rls: boolean; policies: number; accessible: boolean }>(`
      SELECT c.relname AS table, c.relrowsecurity AS rls,
        (SELECT count(*)::integer FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
        has_table_privilege('uco_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS accessible
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
          AND a.attname = 'organization_id' AND NOT a.attisdropped)
      ORDER BY c.relname`);
    expect(result.rows.length).toBeGreaterThan(50);
    expect(result.rows.filter(row => !row.rls || (row.accessible && row.policies === 0)).map(row => row.table)).toEqual([]);
  });

  it('keeps the runtime role non-owner, non-superuser and without BYPASSRLS', async () => {
    const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'uco_app'");
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const owned = await pool.query<{ table: string }>(`SELECT c.relname AS table FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND pg_has_role('uco_app', r.oid, 'USAGE')`);
    expect(owned.rows).toEqual([]);
  });

  it('scopes every foreign key between tenant tables by organization_id', async () => {
    const result = await pool.query<{ constraint: string; table: string; referenced: string }>(`
      WITH tenant AS (
        SELECT c.oid, (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.oid
          AND a.attname = 'organization_id' AND NOT a.attisdropped) AS org_column
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p'))
      SELECT con.conname AS constraint, src.oid::regclass::text AS table, dst.oid::regclass::text AS referenced
      FROM pg_constraint con
      JOIN tenant src ON src.oid = con.conrelid JOIN tenant dst ON dst.oid = con.confrelid
      WHERE con.contype = 'f' AND src.org_column IS NOT NULL AND dst.org_column IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM generate_subscripts(con.conkey, 1) i
          WHERE con.conkey[i] = src.org_column AND con.confkey[i] = dst.org_column)
      ORDER BY 2, 1`);
    expect(result.rows).toEqual([]);
  });

  it('never cascades deletes or updates through tenant history', async () => {
    const result = await pool.query<{ constraint: string; table: string }>(`
      SELECT con.conname AS constraint, con.conrelid::regclass::text AS table
      FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE n.nspname = 'public' AND con.contype = 'f'
        AND (con.confdeltype IN ('c', 'n', 'd') OR con.confupdtype IN ('c', 'n', 'd'))
      ORDER BY 2, 1`);
    expect(result.rows).toEqual([]);
  });
});
