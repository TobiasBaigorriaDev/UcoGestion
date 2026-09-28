import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { CashController } from './cash.controller.js';
import { CashOperationsService } from './cash-operations.service.js';

@Injectable()
class CashDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  async onModuleDestroy() { await this.pool.end(); }
}

@Module({
  controllers: [CashController],
  providers: [CashDatabase, { provide: CashOperationsService,
    useFactory: (database: CashDatabase) => new CashOperationsService(new TenantTransaction(database.pool)),
    inject: [CashDatabase] }],
})
export class CashModule {}
