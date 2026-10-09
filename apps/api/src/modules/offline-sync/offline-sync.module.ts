import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { MetricsService } from '../../core/observability/metrics.service.js';
import { DeviceAuthorizationService } from '../cash/device-authorization.service.js';
import { ConfigurationBarrierController } from './configuration-barrier.controller.js';
import { DeviceAuthorizationController } from './device-authorization.controller.js';
import { OfflineBootstrapController } from './offline-bootstrap.controller.js';
import { OfflineDeliveryController } from './offline-delivery.controller.js';
import { OfflineDeliveryService } from './offline-delivery.service.js';
import { DeviceCertificate } from './device-certificate.js';
import { HistoricalDeliveryIngestion } from './historical-delivery-ingestion.js';
import { HistoricalEnvelopeValidator } from './historical-envelope-validator.js';
import { loadOfflineAckKey, loadOfflineKeys } from './offline-key-custody.js';

@Injectable()
class OfflineDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  async onModuleDestroy() { await this.pool.end(); }
}

@Module({
  controllers: [ConfigurationBarrierController,DeviceAuthorizationController, OfflineBootstrapController, OfflineDeliveryController],
  providers: [OfflineDatabase, { provide: TenantTransaction,
    useFactory: (database: OfflineDatabase) => new TenantTransaction(database.pool), inject: [OfflineDatabase] },
  { provide: OfflineDeliveryService, useFactory: (database: OfflineDatabase, metrics: MetricsService) => new OfflineDeliveryService(database.pool, () => {
    const keys = loadOfflineKeys();
    const secret = process.env.DEVICE_CERTIFICATE_KEY ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Device certificate custody unavailable.');
    return { certificates: new DeviceCertificate(Buffer.from(secret,'base64url')), signingKey: keys.signingKey,
      keyId: keys.signer.keyId, rateLimitPepper: secret };
  }, () => new URL(process.env.UCONEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:3000').origin,
  { deliver: (certificate,envelopes) => {
    const secret=process.env.DEVICE_CERTIFICATE_KEY ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Device certificate custody unavailable.');
    return new HistoricalDeliveryIngestion(new TenantTransaction(database.pool),
      new HistoricalEnvelopeValidator(new DeviceCertificate(Buffer.from(secret,'base64url')),loadOfflineKeys().ingestion),
      loadOfflineAckKey, result => metrics.recordSyncResult(result)).deliver(certificate,envelopes);
  } }), inject: [OfflineDatabase, MetricsService] },
  { provide: DeviceAuthorizationService,
    useFactory: (database: OfflineDatabase) => new DeviceAuthorizationService(new TenantTransaction(database.pool)),
    inject: [OfflineDatabase] }],
})
export class OfflineSyncModule {}
