import { setTimeout as delay } from 'node:timers/promises';

import { Pool } from 'pg';

import { objectStorageOptionsFromEnvironment, S3ObjectStorage } from './core/objects/s3-object-storage.js';
import { handleObjectFileCleanup } from './core/objects/object-file-cleanup.handler.js';
import { OutboxDispatcher, OutboxWorker } from './core/outbox/outbox-worker.js';
import { createJsonLogger } from './core/observability/logger.js';
import { startOtlpTracing } from './core/observability/tracing.js';
import { startWorkerHealth } from './core/observability/worker-health.js';
import { TenantTransaction } from './database/tenant-transaction.js';
import { ReportExportService } from './modules/reports/report-export.service.js';
import { ReportsService } from './modules/reports/reports.service.js';

async function main(): Promise<void> {
  const logger = createJsonLogger({ component: 'report-worker' });
  const stopTracing = startOtlpTracing();
  const databaseUrl = process.env.DATABASE_URL;
  const dispatchUrl = process.env.WORKER_DISPATCH_DATABASE_URL;
  const workerUserId = process.env.WORKER_USER_ID;
  if (!databaseUrl || !dispatchUrl || !workerUserId) {
    throw new Error('DATABASE_URL, WORKER_DISPATCH_DATABASE_URL and WORKER_USER_ID are required.');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(workerUserId)) {
    throw new Error('WORKER_USER_ID must be a UUID.');
  }
  const tenantPool = new Pool({ connectionString: databaseUrl });
  const dispatchPool = new Pool({ connectionString: dispatchUrl });
  const transactions = new TenantTransaction(tenantPool);
  const storage = new S3ObjectStorage(objectStorageOptionsFromEnvironment());
  const exports = new ReportExportService(transactions, new ReportsService(transactions), storage);
  const dispatcher = new OutboxDispatcher(dispatchPool, 'REPORT_ARTIFACTS');
  const worker = new OutboxWorker({ dispatcher, tenantTransactions: transactions,
    workerUserId, maxAttempts: 5, retryBaseSeconds: 2,
    authorizer: { authorize: async (job) => {
      if (job.jobType !== 'REPORT_PDF' && job.jobType !== 'OBJECT_FILE_CLEANUP') {
        throw new Error('Unsupported job type.');
      }
    } },
    handlers: { REPORT_PDF: (job, client) => exports.handle(job, client),
      OBJECT_FILE_CLEANUP: (job, client) => handleObjectFileCleanup(job, client, storage) },
    onDeadLetter: (claim, client) => claim.jobType === 'REPORT_PDF'
      ? exports.markDeadLetter(claim.organizationId, claim.jobId, client)
      : Promise.resolve() });
  let running = true;
  const health = startWorkerHealth(Number(process.env.WORKER_HEALTH_PORT ?? 3001));
  process.once('SIGTERM', () => { running = false; });
  process.once('SIGINT', () => { running = false; });
  try {
    while (running) {
      const claims = await dispatcher.claim(10, 300);
      for (const claim of claims) {
        const result = await worker.process(claim);
        logger.info({ job_id: claim.jobId, job_type: claim.jobType,
          organization_id: claim.organizationId, status: result.status }, 'report artifact job processed');
      }
      health.recordCycle();
      if (claims.length === 0) await delay(2000);
    }
  } finally {
    await health.close();
    await dispatchPool.end();
    await tenantPool.end();
    await stopTracing();
  }
}

void main().catch((error: unknown) => {
  createJsonLogger({ component: 'report-worker' }).error({
    error_code: error instanceof Error ? error.name : 'UNKNOWN',
  }, 'report worker stopped');
  process.exitCode = 1;
});
