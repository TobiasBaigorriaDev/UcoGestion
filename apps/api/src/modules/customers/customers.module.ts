import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { CustomerManagementService } from './customer-management.service.js';
import { CustomersController } from './customers.controller.js';

@Injectable()
class CustomersDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Module({
  controllers: [CustomersController],
  providers: [
    CustomersDatabase,
    {
      provide: CustomerManagementService,
      useFactory: (database: CustomersDatabase) =>
        new CustomerManagementService(new TenantTransaction(database.pool)),
      inject: [CustomersDatabase],
    },
  ],
  exports: [CustomerManagementService],
})
export class CustomersModule {}
