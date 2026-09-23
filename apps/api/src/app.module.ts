import 'reflect-metadata';

import { Module } from '@nestjs/common';

import { AppController } from './app.controller.js';
import { MetricsService } from './core/observability/metrics.service.js';
import { DatabaseReadinessService } from './database-readiness.service.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { PlatformAdminModule } from './modules/platform-admin/platform-admin.module.js';
import { SuppliersModule } from './modules/suppliers/suppliers.module.js';

@Module({
  imports: [
    AuthModule,
    CatalogModule,
    CustomersModule,
    OrganizationsModule,
    PlatformAdminModule,
    SuppliersModule,
  ],
  controllers: [AppController],
  providers: [DatabaseReadinessService, MetricsService],
})
export class AppModule {}
