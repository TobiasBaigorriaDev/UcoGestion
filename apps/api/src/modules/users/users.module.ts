import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { InvitationCreationService } from './invitation-creation.service.js';
import { InvitationRevocationService } from './invitation-revocation.service.js';
import { InvitationResendService } from './invitation-resend.service.js';
import { MembershipAdministrationService } from './membership-administration.service.js';
import { UserManagementReadService } from './user-management-read.service.js';
import { UsersController } from './users.controller.js';

@Injectable()
class UsersDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  async onModuleDestroy() { await this.pool.end(); }
}

@Module({
  controllers: [UsersController],
  providers: [
    UsersDatabase,
    ...[UserManagementReadService, InvitationCreationService, InvitationRevocationService, InvitationResendService, MembershipAdministrationService].map((service) => ({
      provide: service, useFactory: (database: UsersDatabase) => new service(new TenantTransaction(database.pool)), inject: [UsersDatabase],
    })),
  ],
})
export class UsersModule {}
