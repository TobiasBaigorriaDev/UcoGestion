import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { ExpenseCategoryManagementService } from './expense-category-management.service.js';
import { ExpenseCategoriesController } from './expense-categories.controller.js';
import { ExpensesController } from './expenses.controller.js';
import { ExpenseOperationsService } from './expense-operations.service.js';

@Injectable()
class ExpensesDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  async onModuleDestroy(): Promise<void> { await this.pool.end(); }
}

@Module({
  controllers: [ExpenseCategoriesController, ExpensesController],
  providers: [ExpensesDatabase, { provide: ExpenseCategoryManagementService,
    useFactory: (database: ExpensesDatabase) => new ExpenseCategoryManagementService(new TenantTransaction(database.pool)),
    inject: [ExpensesDatabase] }, { provide: ExpenseOperationsService,
    useFactory: (database: ExpensesDatabase) => new ExpenseOperationsService(new TenantTransaction(database.pool)),
    inject: [ExpensesDatabase] }],
})
export class ExpensesModule {}
