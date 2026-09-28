import { randomUUID } from 'node:crypto';

import { BadRequestException, Controller, ForbiddenException, Get, Param, Query, Req,
  UnauthorizedException } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

import { parseCursorPageQuery } from '../../core/validation/pagination.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { ReportAccessError, ReportsService, type ReportDataset,
  type ReportQuery } from './reports.service.js';

const datasetSchema = z.enum(['sales', 'inventory', 'inventory-movements', 'cash',
  'purchases', 'expenses']);
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
  constructor(private readonly service: ReportsService) {}

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
    try { return await this.service.list(this.context(request), dataset.data, query); }
    catch (error) {
      if (error instanceof ReportAccessError) throw new ForbiddenException({
        code: error.code, title: 'Reporte no autorizado', detail: error.message,
      });
      throw error;
    }
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
