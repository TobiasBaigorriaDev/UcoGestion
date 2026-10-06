import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { DeviceAuthorizationService } from '../cash/device-authorization.service.js';
import { DeviceAuthorizationController } from './device-authorization.controller.js';
import { OfflineBootstrapController } from './offline-bootstrap.controller.js';
import { OfflineDeliveryController } from './offline-delivery.controller.js';
import { UnconfiguredHistoricalDeliveryIngestion, OfflineDeliveryService } from './offline-delivery.service.js';
import { DeviceCertificate } from './device-certificate.js';
import { loadOfflineKeys } from './offline-key-custody.js';

@Injectable()
class OfflineDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  async onModuleDestroy() { await this.pool.end(); }
}

@Module({
  controllers: [DeviceAuthorizationController, OfflineBootstrapController, OfflineDeliveryController],
  providers: [OfflineDatabase, { provide: TenantTransaction,
    useFactory: (database: OfflineDatabase) => new TenantTransaction(database.pool), inject: [OfflineDatabase] },
  { provide: OfflineDeliveryService, useFactory: (database: OfflineDatabase) => new OfflineDeliveryService(database.pool, () => {
    const keys = loadOfflineKeys();
    const secret = process.env.DEVICE_CERTIFICATE_KEY ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Device certificate custody unavailable.');
    return { certificates: new DeviceCertificate(Buffer.from(secret,'base64url')), signingKey: keys.signingKey,
      keyId: keys.signer.keyId, rateLimitPepper: secret };
  }, () => new URL(process.env.UCONEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:3000').origin,
  new UnconfiguredHistoricalDeliveryIngestion()), inject: [OfflineDatabase] },
  { provide: DeviceAuthorizationService,
    useFactory: (database: OfflineDatabase) => new DeviceAuthorizationService(new TenantTransaction(database.pool)),
    inject: [OfflineDatabase] }],
})
export class OfflineSyncModule {}
