import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { CatalogCategoryManagementService } from './catalog-category-management.service.js';
import { CatalogItemLifecycleService } from './catalog-item-lifecycle.service.js';
import { CatalogLifecycleController } from './catalog-lifecycle.controller.js';

@Injectable()
class CatalogDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Module({
  controllers: [CatalogLifecycleController],
  providers: [
    CatalogDatabase,
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
