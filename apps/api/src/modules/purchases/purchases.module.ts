import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { PurchaseOperationsService } from './purchase-operations.service.js';
import { PurchasesController } from './purchases.controller.js';

@Injectable()
class PurchasesDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  async onModuleDestroy() { await this.pool.end(); }
}

@Module({
  controllers: [PurchasesController],
  providers: [PurchasesDatabase, { provide: PurchaseOperationsService,
    useFactory: (database: PurchasesDatabase) =>
      new PurchaseOperationsService(new TenantTransaction(database.pool)),
    inject: [PurchasesDatabase] }],
})
export class PurchasesModule {}
