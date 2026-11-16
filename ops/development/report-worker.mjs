import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const load = path => import(new URL(`../../apps/api/dist/${path}`, import.meta.url));
const { TenantTransaction } = await load('database/tenant-transaction.js');
const { OutboxDispatcher, OutboxWorker } = await load('core/outbox/outbox-worker.js');
const { S3ObjectStorage, objectStorageOptionsFromEnvironment } = await load('core/objects/s3-object-storage.js');
const { handleObjectFileCleanup } = await load('core/objects/object-file-cleanup.handler.js');
const { ReportExportService } = await load('modules/reports/report-export.service.js');
const { ReportsService } = await load('modules/reports/reports.service.js');
const { startWorkerHealth } = await load('core/observability/worker-health.js');
if (process.env.NODE_ENV === 'production') throw new Error('Local report worker is development-only');
if (!process.env.DATABASE_URL || !process.env.WORKER_DISPATCH_DATABASE_URL || !process.env.WORKER_USER_ID) {
  throw new Error('Missing local worker configuration');
}
const tenantPool = new Pool({ connectionString: process.env.DATABASE_URL });
const dispatchPool = new Pool({ connectionString: process.env.WORKER_DISPATCH_DATABASE_URL });
const transactions = new TenantTransaction(tenantPool);
const storage = new S3ObjectStorage(objectStorageOptionsFromEnvironment());
const exports = new ReportExportService(transactions, new ReportsService(transactions), storage);
const worker = new OutboxWorker({ dispatcher: new OutboxDispatcher(dispatchPool, 'REPORT_ARTIFACTS'),
  tenantTransactions: transactions, workerUserId: process.env.WORKER_USER_ID,
  maxAttempts: 5, retryBaseSeconds: 2,
  authorizer: { authorize: async job => {
    const expected = { REPORT_PDF: 'REPORT_EXPORT', OBJECT_FILE_CLEANUP: 'OBJECT_FILE_CLEANUP' };
    if (expected[job.jobType] !== job.authorizationClass) throw new Error('Invalid report job authorization');
  } },
  handlers: { REPORT_PDF: (job, client) => exports.handle(job, client),
    OBJECT_FILE_CLEANUP: (job, client) => handleObjectFileCleanup(job, client, storage) },
  onDeadLetter: (claim, client) => claim.jobType === 'REPORT_PDF'
    ? exports.markDeadLetter(claim.organizationId, claim.jobId, client) : Promise.resolve(),
});
const health = startWorkerHealth(Number(process.env.WORKER_HEALTH_PORT ?? 3001));
let running = true;
process.once('SIGINT', () => { running = false; });
process.once('SIGTERM', () => { running = false; });
try {
  while (running) {
    const results = await worker.processAvailable(10, 300);
    for (const result of results) console.log(JSON.stringify(result));
    health.recordCycle();
    if (!results.length) await delay(2000);
  }
} finally {
  await health.close(); await dispatchPool.end(); await tenantPool.end();
}
