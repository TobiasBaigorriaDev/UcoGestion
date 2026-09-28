import 'reflect-metadata';

import { Module } from '@nestjs/common';

import { AppController } from './app.controller.js';
import { MetricsService } from './core/observability/metrics.service.js';
import { DatabaseReadinessService } from './database-readiness.service.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BranchesModule } from './modules/branches/branches.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { CashModule } from './modules/cash/cash.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { ExpensesModule } from './modules/expenses/expenses.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { InventoryLedgerMonitor } from './modules/inventory/inventory-ledger-monitor.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { SalesModule } from './modules/sales/sales.module.js';
import { PurchasesModule } from './modules/purchases/purchases.module.js';
import { PlatformAdminModule } from './modules/platform-admin/platform-admin.module.js';
import { SuppliersModule } from './modules/suppliers/suppliers.module.js';
import { UsersModule } from './modules/users/users.module.js';

@Module({
  imports: [
    AuthModule,
    BranchesModule,
    CatalogModule,
    CashModule,
    CustomersModule,
    ExpensesModule,
    InventoryModule,
    OrganizationsModule,
    SalesModule,
    PurchasesModule,
    PlatformAdminModule,
    SuppliersModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [DatabaseReadinessService, MetricsService, InventoryLedgerMonitor],
})
export class AppModule {}
