import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Pool } from 'pg';

import { AuthController } from './auth.controller.js';
import { LoginService } from './login.service.js';
import { SessionAuthenticationService } from './session-authentication.service.js';
import { TenantAccessGuard } from './tenant-access.guard.js';
import { TenantMembershipService } from './tenant-membership.service.js';

@Injectable()
class GlobalAuthDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Module({
  controllers: [AuthController],
  providers: [
    GlobalAuthDatabase,
    {
      provide: LoginService,
      useFactory: (database: GlobalAuthDatabase) => new LoginService(database.pool),
      inject: [GlobalAuthDatabase],
    },
    {
      provide: SessionAuthenticationService,
      useFactory: (database: GlobalAuthDatabase) => new SessionAuthenticationService(database.pool),
      inject: [GlobalAuthDatabase],
    },
    {
      provide: TenantMembershipService,
      useFactory: (database: GlobalAuthDatabase) => new TenantMembershipService(database.pool),
      inject: [GlobalAuthDatabase],
    },
    { provide: APP_GUARD, useClass: TenantAccessGuard },
  ],
  exports: [SessionAuthenticationService, TenantMembershipService],
})
export class AuthModule {}
