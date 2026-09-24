import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { BranchManagementService } from './branch-management.service.js';
import { BranchReadService } from './branch-read.service.js';
import { BranchesController } from './branches.controller.js';

@Injectable()
class BranchesDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  async onModuleDestroy() { await this.pool.end(); }
}

@Module({
  controllers: [BranchesController],
  providers: [BranchesDatabase,
    { provide: BranchReadService, useFactory: (database: BranchesDatabase) => new BranchReadService(new TenantTransaction(database.pool)), inject: [BranchesDatabase] },
    { provide: BranchManagementService, useFactory: (database: BranchesDatabase) => new BranchManagementService(new TenantTransaction(database.pool)), inject: [BranchesDatabase] },
  ],
})
export class BranchesModule {}
