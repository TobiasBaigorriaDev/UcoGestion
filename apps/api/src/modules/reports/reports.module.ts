import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { objectStorageOptionsFromEnvironment, S3ObjectStorage } from '../../core/objects/s3-object-storage.js';
import { ReportExportService } from './report-export.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Injectable()
class ReportsDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async onModuleDestroy(): Promise<void> { await this.pool.end(); }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsDatabase, { provide: ReportsService,
    useFactory: (database: ReportsDatabase) =>
      new ReportsService(new TenantTransaction(database.pool)),
    inject: [ReportsDatabase] },
  { provide: ReportExportService,
    useFactory: (database: ReportsDatabase, reports: ReportsService) =>
      new ReportExportService(new TenantTransaction(database.pool), reports,
        new S3ObjectStorage(objectStorageOptionsFromEnvironment())),
    inject: [ReportsDatabase, ReportsService] }],
})
export class ReportsModule {}
