import { setTimeout as delay } from 'node:timers/promises';

import { Pool } from 'pg';

import { objectStorageOptionsFromEnvironment, S3ObjectStorage } from './core/objects/s3-object-storage.js';
import { handleObjectFileCleanup } from './core/objects/object-file-cleanup.handler.js';
import { HttpEmailPort } from './core/email/email-port.js';
import { IdentityEmailWorker } from './core/outbox/identity-email-worker.js';
import { createJsonLogger } from './core/observability/logger.js';
import { startOtlpTracing } from './core/observability/tracing.js';
import { startWorkerHealth } from './core/observability/worker-health.js';
import { TenantTransaction } from './database/tenant-transaction.js';
import { ReportExportService } from './modules/reports/report-export.service.js';
import { ReportsService } from './modules/reports/reports.service.js';
import { createTenantWorker } from './runtime-worker.js';

async function main(): Promise<void> {
  const logger = createJsonLogger({ component: 'worker' });
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
  const email = new HttpEmailPort(process.env.EMAIL_GATEWAY_URL ?? '', process.env.EMAIL_GATEWAY_TOKEN ?? '');
  const identityWorker = new IdentityEmailWorker(dispatchPool, email);
  const storage = new S3ObjectStorage(objectStorageOptionsFromEnvironment());
  const exports = new ReportExportService(transactions, new ReportsService(transactions), storage);
  const worker = createTenantWorker({ dispatchPool, transactions, workerUserId, email,
    report: (job, client) => exports.handle(job, client),
    cleanup: (job, client) => handleObjectFileCleanup(job, client, storage),
    onDeadLetter: (claim, client) => claim.jobType === 'REPORT_PDF'
      ? exports.markDeadLetter(claim.organizationId, claim.jobId, client)
      : Promise.resolve() });
  let running = true;
  const health = startWorkerHealth(Number(process.env.WORKER_HEALTH_PORT ?? 3001));
  process.once('SIGTERM', () => { running = false; });
  process.once('SIGINT', () => { running = false; });
  try {
    while (running) {
      const results = [...await worker.processAvailable(10, 300), ...await identityWorker.processAvailable(10, 300)];
      for (const result of results) {
        logger.info({ job_id: result.jobId, status: result.status }, 'outbox job processed');
      }
      health.recordCycle();
      if (results.length === 0) await delay(2000);
    }
  } finally {
    await health.close();
    await dispatchPool.end();
    await tenantPool.end();
    await stopTracing();
  }
}

void main().catch((error: unknown) => {
  createJsonLogger({ component: 'worker' }).error({
    error_code: error instanceof Error ? error.name : 'UNKNOWN',
  }, 'worker stopped');
  process.exitCode = 1;
});
