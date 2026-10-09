import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';

const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

export const runMigrations = async (connectionString: string): Promise<void> => {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock(hashtext('uco:versioned-migrations'))");
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('uco:versioned-migrations'))");
    client.release();
    await pool.end();
  }
};
