import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { CashController } from './cash.controller.js';
import { CashOperationsService } from './cash-operations.service.js';
import { CashCloseService } from './cash-close.service.js';
import { CashDifferenceReviewService } from './cash-difference-review.service.js';
import { ExceptionalCashCloseService } from './exceptional-cash-close.service.js';
import { LateCashReviewService } from './late-cash-review.service.js';
import { CashWorkspaceService } from './cash-workspace.service.js';

@Injectable()
class CashDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  async onModuleDestroy() { await this.pool.end(); }
}

@Module({
  controllers: [CashController],
  providers: [CashDatabase, { provide: CashOperationsService,
    useFactory: (database: CashDatabase) => new CashOperationsService(new TenantTransaction(database.pool)),
    inject: [CashDatabase] }, { provide: CashCloseService,
    useFactory: (database: CashDatabase) => new CashCloseService(new TenantTransaction(database.pool)),
    inject: [CashDatabase] }, { provide: CashDifferenceReviewService,
    useFactory: (database: CashDatabase) => new CashDifferenceReviewService(new TenantTransaction(database.pool)),
    inject: [CashDatabase] }, { provide: ExceptionalCashCloseService,
    useFactory: (database: CashDatabase) => new ExceptionalCashCloseService(new TenantTransaction(database.pool)),
    inject: [CashDatabase] }, { provide: LateCashReviewService,
    useFactory: (database: CashDatabase) => new LateCashReviewService(new TenantTransaction(database.pool)),
    inject: [CashDatabase] }, { provide: CashWorkspaceService,
    useFactory: (database: CashDatabase) => new CashWorkspaceService(new TenantTransaction(database.pool)),
    inject: [CashDatabase] }],
})
export class CashModule {}
