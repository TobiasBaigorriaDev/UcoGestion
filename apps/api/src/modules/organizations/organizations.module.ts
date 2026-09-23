import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { AuthModule } from '../auth/auth.module.js';
import { GlobalMembershipDiscoveryService } from './global-membership-discovery.service.js';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationProfileService } from './organization-profile.service.js';
import { OrganizationTimezoneService } from './organization-timezone.service.js';
import { OrganizationCurrencyChangeService } from './organization-currency-change.service.js';
import { OrganizationSettingsService } from './organization-settings.service.js';
import { TenantTransaction } from '../../database/tenant-transaction.js';

@Injectable()
class GlobalOrganizationDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Module({
  imports: [AuthModule],
  controllers: [OrganizationsController],
  providers: [
    GlobalOrganizationDatabase,
    {
      provide: GlobalMembershipDiscoveryService,
      useFactory: (database: GlobalOrganizationDatabase) => new GlobalMembershipDiscoveryService(database.pool),
      inject: [GlobalOrganizationDatabase],
    },
    {
      provide: OrganizationProfileService,
      useFactory: (database: GlobalOrganizationDatabase) =>
        new OrganizationProfileService(new TenantTransaction(database.pool)),
      inject: [GlobalOrganizationDatabase],
    },
    {
      provide: OrganizationTimezoneService,
      useFactory: (database: GlobalOrganizationDatabase) =>
        new OrganizationTimezoneService(new TenantTransaction(database.pool)),
      inject: [GlobalOrganizationDatabase],
    },
    {
      provide: OrganizationCurrencyChangeService,
      useFactory: (database: GlobalOrganizationDatabase) =>
        new OrganizationCurrencyChangeService(new TenantTransaction(database.pool)),
      inject: [GlobalOrganizationDatabase],
    },
    {
      provide: OrganizationSettingsService,
      useFactory: (database: GlobalOrganizationDatabase) =>
        new OrganizationSettingsService(new TenantTransaction(database.pool)),
      inject: [GlobalOrganizationDatabase],
    },
  ],
})
export class OrganizationsModule {}
