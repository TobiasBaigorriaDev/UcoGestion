import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { InventoryAdjustmentService } from './inventory-adjustment.service.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryTransferService } from './inventory-transfer.service.js';
import { StockThresholdService } from './stock-threshold.service.js';

@Injectable()
class InventoryDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  async onModuleDestroy() { await this.pool.end(); }
}

@Module({
  controllers: [InventoryController],
  providers: [
    InventoryDatabase,
    { provide: InventoryAdjustmentService,
      useFactory: (database: InventoryDatabase) => new InventoryAdjustmentService(new TenantTransaction(database.pool)),
      inject: [InventoryDatabase] },
    { provide: StockThresholdService,
      useFactory: (database: InventoryDatabase) => new StockThresholdService(new TenantTransaction(database.pool)),
      inject: [InventoryDatabase] },
    { provide: InventoryTransferService,
      useFactory: (database: InventoryDatabase) => new InventoryTransferService(new TenantTransaction(database.pool)),
      inject: [InventoryDatabase] },
  ],
})
export class InventoryModule {}
