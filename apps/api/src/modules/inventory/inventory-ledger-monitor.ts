import { randomUUID } from 'node:crypto';

import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { z } from 'zod';

import { createJsonLogger } from '../../core/observability/logger.js';
import { MetricsService } from '../../core/observability/metrics.service.js';
import { TenantTransaction } from '../../database/tenant-transaction.js';
import { InventoryLedgerVerifier } from './inventory-ledger-verifier.js';

const contextsSchema = z.array(z.strictObject({ organizationId: z.uuid(), userId: z.uuid() }));
const intervalMs = 15 * 60 * 1000;

/** Optional periodic monitor. Ops supplies one active service membership per organization. */
@Injectable()
export class InventoryLedgerMonitor implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pool: Pool | undefined;
  private running = false;
  private readonly logger = createJsonLogger({ component: 'inventory-ledger-verifier' });

  constructor(private readonly metrics: MetricsService) {}

  onModuleInit(): void {
    const configured = process.env.INVENTORY_VERIFIER_CONTEXTS;
    if (!configured) return;
    const contexts = contextsSchema.parse(JSON.parse(configured) as unknown);
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const run = () => void this.verifyAll(contexts);
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pool?.end();
  }

  private async verifyAll(contexts: z.infer<typeof contextsSchema>): Promise<void> {
    if (this.running || !this.pool) return;
    this.running = true;
    let divergent = 0;
    let failed = false;
    try {
      const verifier = new InventoryLedgerVerifier(new TenantTransaction(this.pool), (difference) => {
        this.logger.error({ organization_id: difference.organizationId, branch_id: difference.branchId,
          item_id: difference.itemId, projected: difference.projected, ledger: difference.ledger },
        'inventory ledger and projection diverged');
      });
      for (const context of contexts) {
        try {
          const result = await verifier.verify({ ...context, requestId: `inventory-verify:${randomUUID()}` });
          divergent += result.divergent;
        } catch (error) {
          failed = true;
          this.metrics.recordInventoryVerificationFailure();
          this.logger.error({ organization_id: context.organizationId,
            error_code: error instanceof Error ? error.name : 'UNKNOWN' }, 'inventory verification failed');
        }
      }
      if (!failed) this.metrics.recordInventoryVerification(divergent);
    } finally { this.running = false; }
  }
}
