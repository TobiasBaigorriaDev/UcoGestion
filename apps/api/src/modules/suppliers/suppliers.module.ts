import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { SupplierManagementService } from './supplier-management.service.js';
import { SuppliersController } from './suppliers.controller.js';

@Injectable()
class SuppliersDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Module({
  controllers: [SuppliersController],
  providers: [
    SuppliersDatabase,
    {
      provide: SupplierManagementService,
      useFactory: (database: SuppliersDatabase) =>
        new SupplierManagementService(new TenantTransaction(database.pool)),
      inject: [SuppliersDatabase],
    },
  ],
  exports: [SupplierManagementService],
})
export class SuppliersModule {}
