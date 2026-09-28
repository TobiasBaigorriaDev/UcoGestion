import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { TenantTransaction } from '../../database/tenant-transaction.js';
import { AuditController } from './audit.controller.js';
import { AuditQueryService } from './audit-query.service.js';

@Injectable()
class AuditDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async onModuleDestroy(): Promise<void> { await this.pool.end(); }
}

@Module({
  controllers: [AuditController],
  providers: [AuditDatabase, { provide: AuditQueryService,
    useFactory: (database: AuditDatabase) => new AuditQueryService(new TenantTransaction(database.pool)),
    inject: [AuditDatabase] }],
})
export class AuditModule {}
