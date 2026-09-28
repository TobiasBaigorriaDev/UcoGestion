import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get,
  Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

import { parseCursorPageQuery } from '../../core/validation/pagination.js';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError,
  IdempotencyReplayPendingError } from '../../core/idempotency/idempotency.service.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { csvHeader, csvRow } from './report-csv.js';
import { ReportExportService } from './report-export.service.js';
import { ReportAccessError, ReportsService, type ReportDataset,
  type ReportQuery } from './reports.service.js';

const datasetSchema = z.enum(['sales', 'inventory', 'inventory-movements', 'cash',
  'purchases', 'expenses']);
const exportFiltersSchema = z.strictObject({ branchId: z.uuid().optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(), status: z.string().optional(),
  lowStock: z.boolean().optional() });
const statusValues: Partial<Record<ReportDataset, readonly string[]>> = {
  sales: ['CONFIRMED', 'CANCELLED'],
  cash: ['OPEN', 'CLOSING', 'CONFLICTED', 'CLOSED', 'CLOSED_CONFLICT_RESOLVED',
    'CLOSED_WITH_UNRECOVERED_DEVICE'],
  purchases: ['PENDING_PAYMENT', 'PAID', 'CANCELLED'],
  expenses: ['CONFIRMED', 'CANCELLED'],
};

interface ReportRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService,
    private readonly exports: ReportExportService) {}

  @Post(':dataset/exports')
  async queueExport(@Req() request: ReportRequest, @Param('dataset') rawDataset: string,
    @Body() rawBody: unknown) {
    const body = exportFiltersSchema.safeParse(rawBody);
    if (!body.success) throw this.invalid();
    const filters = Object.fromEntries(Object.entries(body.data)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [name, String(value)]));
    const { dataset, query } = this.parse(rawDataset, { ...filters, limit: 100 });
    const key = requireIdempotencyKey(request.headers);
    try { return await this.exports.queue(this.context(request), dataset, query, key); }
    catch (error) { this.handleAccessError(error); }
  }

  @Get('exports/:id')
  async exportStatus(@Req() request: ReportRequest, @Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw this.invalid();
    try { return await this.exports.get(this.context(request), id); }
    catch (error) { this.handleAccessError(error); }
  }

  @Get(':dataset/csv')
  async csv(@Req() request: ReportRequest, @Param('dataset') rawDataset: string,
    @Query() rawQuery: Record<string, unknown>, @Res() response: ServerResponse): Promise<void> {
    if (rawQuery.cursor !== undefined || rawQuery.limit !== undefined) throw this.invalid();
    const dataset = datasetSchema.safeParse(rawDataset);
    if (!dataset.success) throw this.invalid();
    const datasetName = dataset.data;
    const filters = { ...rawQuery, limit: 100 };
    let page = await this.list(request, rawDataset, filters);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${datasetName}.csv"`);
    response.setHeader('Cache-Control', 'no-store');
    const fetchPage = (cursor: string) => this.list(request, rawDataset,
      { ...filters, cursor });
    async function* rows() {
      yield csvHeader(datasetName);
      while (true) {
        for (const item of page.items) yield csvRow(datasetName, item);
        if (!page.nextCursor) return;
        page = await fetchPage(page.nextCursor);
      }
    }
    await pipeline(Readable.from(rows()), response);
  }

  @Get(':dataset')
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'branchId', required: false, type: String })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'lowStock', required: false, type: String })
  async list(@Req() request: ReportRequest, @Param('dataset') rawDataset: string,
    @Query() rawQuery: Record<string, unknown>) {
    const { dataset, query } = this.parse(rawDataset, rawQuery);
    try { return await this.service.list(this.context(request), dataset, query); }
    catch (error) { this.handleAccessError(error); }
  }

  private parse(rawDataset: string, rawQuery: Record<string, unknown>): {
    dataset: ReportDataset; query: ReportQuery;
  } {
    const dataset = datasetSchema.safeParse(rawDataset);
    if (!dataset.success) throw this.invalid();
    let query: ReportQuery;
    try {
      const allowed = ['branchId', 'from', 'to'];
      if (statusValues[dataset.data]) allowed.push('status');
      if (dataset.data === 'inventory') allowed.push('lowStock');
      const page = parseCursorPageQuery(rawQuery, allowed);
      const { filters, cursor } = page;
      if (filters.branchId && !z.uuid().safeParse(filters.branchId).success) throw new Error();
      if (filters.from && !z.iso.date().safeParse(filters.from).success) throw new Error();
      if (filters.to && !z.iso.date().safeParse(filters.to).success) throw new Error();
      if (filters.from && filters.to && filters.from >= filters.to) throw new Error();
      if (filters.status && !statusValues[dataset.data]?.includes(filters.status)) throw new Error();
      if (filters.lowStock && !['true', 'false'].includes(filters.lowStock)) throw new Error();
      if (cursor && !(dataset.data === 'inventory'
        ? z.uuid().safeParse(cursor.sortValue).success
        : z.iso.datetime({ offset: true }).safeParse(cursor.sortValue).success)) {
        throw new Error();
      }
      query = { limit: page.limit, cursor, branchId: filters.branchId,
        from: filters.from, to: filters.to, status: filters.status,
        lowStock: filters.lowStock === undefined ? undefined : filters.lowStock === 'true' };
    } catch { throw this.invalid(); }
    return { dataset: dataset.data, query };
  }

  private handleAccessError(error: unknown): never {
    if (error instanceof ReportAccessError) throw new ForbiddenException({
      code: error.code, title: 'Reporte no autorizado', detail: error.message });
    if (error instanceof IdempotencyKeyReusedError) throw new ConflictException({
      code: 'IDEMPOTENCY_KEY_REUSED', title: 'Clave reutilizada', detail: 'La clave ya se usó con otros datos.' });
    if (error instanceof IdempotencyReplayForbiddenError) throw new ForbiddenException({
      code: 'IDEMPOTENCY_REPLAY_FORBIDDEN', title: 'Acceso denegado', detail: 'No podés recuperar esta operación.' });
    if (error instanceof IdempotencyReplayPendingError) throw new ConflictException({
      code: 'IDEMPOTENCY_REPLAY_PENDING', title: 'Operación en curso', detail: 'Intentá nuevamente.' });
    throw error;
  }

  private invalid() {
    return new BadRequestException({ code: 'REPORT_QUERY_INVALID',
      title: 'Filtros de reporte inválidos', detail: 'Revisá el dataset y los filtros.' });
  }

  private context(request: ReportRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
        ? requestId : randomUUID() };
  }
}
