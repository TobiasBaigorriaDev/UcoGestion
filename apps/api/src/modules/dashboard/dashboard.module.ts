import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Injectable()
class DashboardDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async onModuleDestroy(): Promise<void> { await this.pool.end(); }
}

@Module({
  controllers: [DashboardController],
  providers: [DashboardDatabase, { provide: DashboardService,
    useFactory: (database: DashboardDatabase) =>
      new DashboardService(new TenantTransaction(database.pool)),
    inject: [DashboardDatabase] }],
})
export class DashboardModule {}
