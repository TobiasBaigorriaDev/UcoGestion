import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { z } from 'zod';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { MetricsService } from './metrics.service.js';
import { createJsonLogger } from './logger.js';

export async function readIdentityDeadLetters(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM identity_outbox_jobs WHERE status='DEAD_LETTER'",
  );
  const row = result.rows[0];
  if (!row) throw new Error('Identity operational snapshot unavailable.');
  return row.count;
}

export async function readOperationalSnapshot(transactions: TenantTransaction, context: TenantTransactionContext) {
  return transactions.read(context, async (client) => {
    const member = await client.query(`SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2
      AND status='ACTIVE' AND revoked_at IS NULL AND role='OWNER'`, [context.organizationId, context.userId]);
    if (member.rowCount !== 1) throw new Error('Operational monitor requires an active OWNER context.');
    const result = await client.query<{ deadLetters: number; conflicts: number; syncPendingAgeSeconds: number }>(`
      SELECT (SELECT count(*)::int FROM outbox_jobs WHERE status='DEAD_LETTER') AS "deadLetters",
        ((SELECT count(*) FROM inventory_incidents WHERE status<>'RESOLVED') +
         (SELECT count(*) FROM cash_sessions WHERE status='CONFLICTED') +
         (SELECT count(*) FROM cash_difference_reviews r WHERE NOT EXISTS
           (SELECT 1 FROM cash_difference_review_events e WHERE e.organization_id=r.organization_id AND e.review_id=r.id)))::int AS conflicts,
        COALESCE((SELECT max(extract(epoch FROM now()-received_at)) FROM sync_operations WHERE status='PENDING'),0)::float8 AS "syncPendingAgeSeconds"`);
    const snapshot = result.rows[0];
    if (!snapshot) throw new Error('Operational snapshot unavailable.');
    return snapshot;
  });
}

@Injectable()
export class OperationalMonitor implements OnModuleInit, OnModuleDestroy {
  private pool: Pool | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  constructor(private readonly metrics: MetricsService) {}
  onModuleInit(): void {
    if (!process.env.OPERATIONS_MONITOR_CONTEXTS) return;
    const contexts = z.array(z.strictObject({ organizationId: z.uuid(), userId: z.uuid() })).min(1)
      .parse(JSON.parse(process.env.OPERATIONS_MONITOR_CONTEXTS));
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, query_timeout: 10000 });
    const pool = this.pool;
    const transactions = new TenantTransaction(pool);
    const run = () => {
      if (this.pending) return;
      this.pending = (async () => {
        const total = { deadLetters: 0, conflicts: 0, syncPendingAgeSeconds: 0 };
        for (const context of contexts) {
          const snapshot = await readOperationalSnapshot(transactions, { ...context, requestId: randomUUID() });
          total.deadLetters += snapshot.deadLetters;
          total.conflicts += snapshot.conflicts;
          total.syncPendingAgeSeconds = Math.max(total.syncPendingAgeSeconds, snapshot.syncPendingAgeSeconds);
        }
        total.deadLetters += await readIdentityDeadLetters(pool);
        this.metrics.recordOperationalSnapshot(total);
      })().catch(() => { createJsonLogger({ component: 'operations-monitor' }).error({ error_code: 'SNAPSHOT_FAILED' }, 'Operational snapshot failed'); })
        .finally(() => { this.pending = undefined; });
    };
    run();
    this.timer = setInterval(run, 60000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    await this.pool?.end();
  }
}
