import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrate.js';

it('T235 serializes simultaneous migration jobs and safely replays the versioned journal', async () => {
  const container=await new PostgreSqlContainer('postgres:16-alpine').start();
  const pool=new Pool({connectionString:container.getConnectionUri()});
  try {
    await Promise.all([runMigrations(container.getConnectionUri()),runMigrations(container.getConnectionUri())]);
    await runMigrations(container.getConnectionUri());
    const result=await pool.query('SELECT count(*)::int AS count,count(DISTINCT hash)::int AS unique_count FROM drizzle.__drizzle_migrations');
    expect(result.rows[0]?.count).toBeGreaterThan(100);
    expect(result.rows[0]?.count).toEqual(result.rows[0]?.unique_count);
  } finally {await pool.end();await container.stop();}
});
