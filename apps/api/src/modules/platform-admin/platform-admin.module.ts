import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PlatformAdminController } from './platform-admin.controller.js';
import { PlatformDatabase } from './platform-database.js';
import { PlatformProvisioningService } from './platform-provisioning.service.js';
import { PlatformOwnerRecoveryService } from './platform-owner-recovery.service.js';

@Module({
  imports: [AuthModule],
  controllers: [PlatformAdminController],
  providers: [
    {
      provide: PlatformDatabase,
      useFactory: () => {
        const connectionString = process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL;
        if (!connectionString && process.env.NODE_ENV === 'production') {
          throw new Error('PLATFORM_DATABASE_URL is required in production.');
        }
        return new PlatformDatabase({ connectionString: connectionString ?? '' });
      },
    },
    {
      provide: PlatformProvisioningService,
      useFactory: (database: PlatformDatabase) => new PlatformProvisioningService(database),
      inject: [PlatformDatabase],
    },
    {
      provide: PlatformOwnerRecoveryService,
      useFactory: (database: PlatformDatabase) => new PlatformOwnerRecoveryService(database),
      inject: [PlatformDatabase],
    },
  ],
})
export class PlatformAdminModule {}
