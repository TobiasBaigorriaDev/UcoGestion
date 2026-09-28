import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { ObjectStoragePort } from '../../core/objects/object-storage.port.js';
import { toJsonValue } from '../../core/idempotency/idempotency.service.js';
import { TemporaryObjectExpiredError, TemporaryObjectService } from '../../core/objects/temporary-object.service.js';
import type { OutboxJob } from '../../core/outbox/outbox-worker.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { renderReportPdf } from './report-pdf.js';
import { ReportAccessError, ReportsService, type ReportDataset, type ReportQuery,
  type ReportItem } from './reports.service.js';

const datasetSchema = z.enum(['sales', 'inventory', 'inventory-movements', 'cash',
  'purchases', 'expenses']);
const filtersSchema = z.strictObject({ branchId: z.uuid().optional(), from: z.iso.date().optional(),
  to: z.iso.date().optional(), status: z.string().optional(), lowStock: z.boolean().optional() });
const payloadSchema = z.strictObject({ exportId: z.uuid() });
type Filters = z.infer<typeof filtersSchema>;

export class ReportExportService {
  constructor(private readonly transactions: TenantTransaction,
    private readonly reports: ReportsService,
    private readonly storage: ObjectStoragePort) {}

  async queue(context: TenantTransactionContext, dataset: ReportDataset, query: ReportQuery,
    idempotencyKey: string): Promise<{ id: string; status: 'QUEUED' }> {
    if (query.cursor || query.limit !== 100) throw new Error('Invalid PDF export query.');
    const filters = filtersSchema.parse({ branchId: query.branchId, from: query.from,
      to: query.to, status: query.status, lowStock: query.lowStock });
    const exportId = randomUUID();
    const auditEvent = { action: 'report_export.queued', entityType: 'report_export',
      entityId: exportId, branchId: query.branchId ?? null, operationId: exportId,
      before: {}, beforeAllowlist: [], after: { status: 'QUEUED' },
      afterAllowlist: ['status'], context: { dataset }, contextAllowlist: ['dataset'] };
    return this.transactions.runIdempotent(context, auditEvent, {
      actorUserId: context.userId, authorizationClass: 'REPORT_EXPORT',
      branchId: query.branchId ?? null, key: idempotencyKey, organizationId: context.organizationId,
      payload: { dataset, filters: toJsonValue(filters) }, scope: 'report.export.pdf',
    }, async (client) => { await this.reports.authorize(client, context, dataset, query); },
    async (client) => {
      const id = exportId;
      await client.query(`INSERT INTO report_exports
        (id,organization_id,actor_user_id,dataset,format,filters,status)
        VALUES ($1,$2,$3,$4,'PDF',$5::jsonb,'QUEUED')`,
      [id, context.organizationId, context.userId, dataset, JSON.stringify(filters)]);
      await client.query(`INSERT INTO outbox_jobs (id,organization_id,job_key,job_type,payload,
        actor_user_id,branch_id,authorization_class)
        VALUES ($1,$2,$3,'REPORT_PDF',$4::jsonb,$5,$6,'REPORT_EXPORT')`,
      [randomUUID(), context.organizationId, `report-pdf:${id}`,
        JSON.stringify({ exportId: id }), context.userId, query.branchId ?? null]);
      return { id, status: 'QUEUED' as const };
    }, (body) => z.object({ id: z.uuid(), status: z.literal('QUEUED') }).parse(body));
  }

  async get(context: TenantTransactionContext, id: string): Promise<{
    id: string; status: string; url?: string | undefined; errorCode?: string | undefined;
  }> {
    const row = await this.transactions.read(context, async (client) => {
      const result = await client.query<{ id: string; dataset: ReportDataset; filters: Filters;
        status: string; file_id: string | null; error_code: string | null }>(`SELECT id,dataset,
        filters,status,file_id,error_code FROM report_exports
        WHERE id = $1 AND organization_id = $2 AND actor_user_id = $3`,
      [id, context.organizationId, context.userId]);
      const exportRow = result.rows[0];
      if (!exportRow) throw new ReportAccessError('REPORT_ACCESS_FORBIDDEN');
      const filters = filtersSchema.parse(exportRow.filters);
      await this.reports.authorize(client, context, datasetSchema.parse(exportRow.dataset),
        { ...filters, limit: 100 });
      return exportRow;
    });
    if (row.status !== 'READY' || !row.file_id) {
      return { id: row.id, status: row.status, errorCode: row.error_code ?? undefined };
    }
    try {
      const url = await new TemporaryObjectService(this.transactions, this.storage)
        .signedUrl(context, row.file_id);
      return { id: row.id, status: row.status, url };
    } catch (error) {
      if (!(error instanceof TemporaryObjectExpiredError)) throw error;
      return { id: row.id, status: 'EXPIRED' };
    }
  }

  async handle(job: OutboxJob, client: PoolClient): Promise<void> {
    if (job.jobType !== 'REPORT_PDF') throw new Error('Invalid report job type.');
    const { exportId } = payloadSchema.parse(job.payload);
    const result = await client.query<{ actor_user_id: string; dataset: ReportDataset;
      filters: Filters; status: string }>(`SELECT actor_user_id,dataset,filters,status
      FROM report_exports WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [exportId, job.organizationId]);
    const row = result.rows[0];
    if (!row || row.actor_user_id !== job.actorUserId) throw new Error('Invalid report job actor.');
    if (row.status === 'READY' || row.status === 'FAILED' || row.status === 'EXPIRED') return;
    const dataset = datasetSchema.parse(row.dataset);
    const filters = filtersSchema.parse(row.filters);
    const actorContext = { organizationId: job.organizationId, userId: job.actorUserId,
      requestId: `report-export:${exportId}` };
    try {
      await this.reports.authorize(client, actorContext, dataset, { ...filters, limit: 100 });
    } catch (error) {
      if (!(error instanceof ReportAccessError)) throw error;
      await client.query(`UPDATE report_exports SET status = 'FAILED',
        error_code = 'REPORT_SCOPE_REVOKED', updated_at = now()
        WHERE organization_id = $1 AND id = $2`, [job.organizationId, exportId]);
      return;
    }
    await client.query(`UPDATE report_exports SET status = 'RUNNING', updated_at = now()
      WHERE organization_id = $1 AND id = $2`, [job.organizationId, exportId]);
    const items: ReportItem[] = [];
    let cursor: ReportQuery['cursor'];
    do {
      const page = await this.reports.list(actorContext, dataset, { ...filters, limit: 100, cursor });
      items.push(...page.items);
      cursor = page.nextCursor ? this.parseCursor(page.nextCursor) : undefined;
    } while (cursor);
    await this.reports.authorize(client, actorContext, dataset, { ...filters, limit: 100 });
    const pdf = await renderReportPdf(dataset, items);
    const key = `exports/${job.organizationId}/${exportId}`;
    await this.storage.put(key, pdf, 'application/pdf');
    await this.reports.authorize(client, actorContext, dataset, { ...filters, limit: 100 });
    await client.query(`INSERT INTO object_files (id,organization_id,actor_user_id,
      storage_key,file_name,content_type,size_bytes,expires_at)
      VALUES ($1,$2,$3,$4,$5,'application/pdf',$6,now() + interval '24 hours')
      ON CONFLICT (id) DO NOTHING`,
    [exportId, job.organizationId, job.actorUserId, key, `${dataset}-${exportId}.pdf`, pdf.byteLength]);
    await client.query(`INSERT INTO outbox_jobs (id,organization_id,job_key,job_type,
      payload,actor_user_id,authorization_class,available_at)
      VALUES ($1,$2,$3,'OBJECT_FILE_CLEANUP',$4::jsonb,$5,'OBJECT_FILE_CLEANUP',
        now() + interval '24 hours') ON CONFLICT (organization_id,job_key) DO NOTHING`,
    [randomUUID(), job.organizationId, `object-file-cleanup:${exportId}`,
      JSON.stringify({ fileId: exportId }), job.actorUserId]);
    await client.query(`UPDATE report_exports SET status = 'READY', file_id = $3,
      updated_at = now(), error_code = NULL WHERE organization_id = $1 AND id = $2`,
    [job.organizationId, exportId, exportId]);
  }

  async markDeadLetter(organizationId: string, jobId: string, client: PoolClient): Promise<void> {
    await client.query(`UPDATE report_exports SET status = 'FAILED',
        error_code = 'REPORT_GENERATION_FAILED', updated_at = now()
        WHERE organization_id = $1 AND id = (
          SELECT (payload->>'exportId')::uuid FROM outbox_jobs
          WHERE organization_id = $1 AND id = $2 AND job_type = 'REPORT_PDF'
            AND status = 'DEAD_LETTER') AND status IN ('QUEUED', 'RUNNING')`,
    [organizationId, jobId]);
  }

  private parseCursor(encoded: string): NonNullable<ReportQuery['cursor']> {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return z.strictObject({ id: z.uuid(), sortValue: z.string() }).parse(parsed);
  }
}
