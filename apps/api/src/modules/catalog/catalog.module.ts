import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { CatalogCategoryManagementService } from './catalog-category-management.service.js';
import { CatalogItemCreationService } from './catalog-item-creation.service.js';
import { CatalogItemEditService } from './catalog-item-edit.service.js';
import { CatalogItemManagementController } from './catalog-item-management.controller.js';
import { CatalogItemLifecycleService } from './catalog-item-lifecycle.service.js';
import { CatalogLifecycleController } from './catalog-lifecycle.controller.js';
import { CatalogReadController } from './catalog-read.controller.js';
import { CatalogReadService } from './catalog-read.service.js';
import { CatalogPriceService } from './catalog-price.service.js';

@Injectable()
class CatalogDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Module({
  controllers: [CatalogLifecycleController, CatalogReadController, CatalogItemManagementController],
  providers: [
    CatalogDatabase,
    { provide: CatalogReadService, useFactory: (database: CatalogDatabase) => new CatalogReadService(new TenantTransaction(database.pool)), inject: [CatalogDatabase] },
    { provide: CatalogItemCreationService, useFactory: (database: CatalogDatabase) => new CatalogItemCreationService(new TenantTransaction(database.pool)), inject: [CatalogDatabase] },
    { provide: CatalogItemEditService, useFactory: (database: CatalogDatabase) => new CatalogItemEditService(new TenantTransaction(database.pool)), inject: [CatalogDatabase] },
    { provide: CatalogPriceService, useFactory: (database: CatalogDatabase) => new CatalogPriceService(new TenantTransaction(database.pool)), inject: [CatalogDatabase] },
    {
      provide: CatalogItemLifecycleService,
      useFactory: (database: CatalogDatabase) =>
        new CatalogItemLifecycleService(new TenantTransaction(database.pool)),
      inject: [CatalogDatabase],
    },
    {
      provide: CatalogCategoryManagementService,
      useFactory: (database: CatalogDatabase) =>
        new CatalogCategoryManagementService(new TenantTransaction(database.pool)),
      inject: [CatalogDatabase],
    },
  ],
})
export class CatalogModule {}
