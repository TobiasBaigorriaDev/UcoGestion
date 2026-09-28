import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { SalesController } from './sales.controller.js';
import { SalesOperationsService } from './sales-operations.service.js';

@Injectable()
class SalesDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  async onModuleDestroy() { await this.pool.end(); }
}

@Module({
  controllers: [SalesController],
  providers: [SalesDatabase, { provide: SalesOperationsService,
    useFactory: (database: SalesDatabase) => new SalesOperationsService(new TenantTransaction(database.pool)),
    inject: [SalesDatabase] }],
})
export class SalesModule {}
