import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Pool } from 'pg';

import { AuthController } from './auth.controller.js';
import { CsrfService } from './csrf.service.js';
import { LoginService } from './login.service.js';
import { PasswordResetRequestService } from './password-reset-request.service.js';
import { PasswordResetConsumeService } from './password-reset-consume.service.js';
import { PostgresRateLimitService } from './postgres-rate-limit.service.js';
import { SessionAuthenticationService } from './session-authentication.service.js';
import { SessionRevocationService } from './session-revocation.service.js';
import { RequestIntegrityGuard } from './request-integrity.guard.js';
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
      provide: PostgresRateLimitService,
      useFactory: (database: GlobalAuthDatabase) => new PostgresRateLimitService(database.pool, {
        limits: { INVITATION: 5, LOGIN: 10, PASSWORD_RESET: 5 },
        pepper: process.env.RATE_LIMIT_PEPPER ?? 'uconext-development-rate-limit-pepper',
        windowSeconds: 900,
      }),
      inject: [GlobalAuthDatabase],
    },
    {
      provide: LoginService,
      useFactory: (database: GlobalAuthDatabase, rateLimits: PostgresRateLimitService) =>
        new LoginService(database.pool, rateLimits),
      inject: [GlobalAuthDatabase, PostgresRateLimitService],
    },
    {
      provide: PasswordResetRequestService,
      useFactory: (database: GlobalAuthDatabase, rateLimits: PostgresRateLimitService) =>
        new PasswordResetRequestService(database.pool, rateLimits),
      inject: [GlobalAuthDatabase, PostgresRateLimitService],
    },
    {
      provide: PasswordResetConsumeService,
      useFactory: (database: GlobalAuthDatabase) => new PasswordResetConsumeService(database.pool),
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
    {
      provide: SessionRevocationService,
      useFactory: (database: GlobalAuthDatabase) => new SessionRevocationService(database.pool),
      inject: [GlobalAuthDatabase],
    },
    {
      provide: CsrfService,
      useFactory: (database: GlobalAuthDatabase) => new CsrfService(database.pool),
      inject: [GlobalAuthDatabase],
    },
    { provide: APP_GUARD, useClass: TenantAccessGuard },
    { provide: APP_GUARD, useClass: RequestIntegrityGuard },
  ],
  exports: [CsrfService, SessionAuthenticationService, SessionRevocationService, TenantMembershipService],
})
export class AuthModule {}
