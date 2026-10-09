import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class DatabaseReadinessService implements OnModuleDestroy {
  private readonly pool: Pool | undefined;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    this.pool = connectionString === undefined ? undefined : new Pool({ connectionString, connectionTimeoutMillis: 3000, query_timeout: 3000 });
  }

  async isReady(): Promise<boolean> {
    if (this.pool === undefined) {
      return false;
    }

    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
