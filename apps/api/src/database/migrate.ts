import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';

const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

export const runMigrations = async (connectionString: string): Promise<void> => {
  const pool = new Pool({ connectionString });

  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder });
  } finally {
    await pool.end();
  }
};
