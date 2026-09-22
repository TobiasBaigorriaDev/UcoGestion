import { Pool, type PoolClient } from 'pg';

export interface PlatformDatabaseOptions {
  readonly connectionString: string;
}

export class PlatformDatabase {
  private readonly pool: Pool;

  constructor(options: PlatformDatabaseOptions) {
    this.pool = new Pool({ connectionString: options.connectionString });
  }

  async withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SET ROLE uco_platform');
      return await work(client);
    } finally {
      try {
        await client.query('RESET ROLE');
      } finally {
        client.release();
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
