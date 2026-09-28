import { randomUUID } from 'node:crypto';

import { BadRequestException, Controller, ForbiddenException, Get, Query, Req,
  UnauthorizedException } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

import { parseCursorPageQuery } from '../../core/validation/pagination.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { AuditAccessError, AuditQueryService } from './audit-query.service.js';

interface AuditRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('audit')
export class AuditController {
  constructor(private readonly service: AuditQueryService) {}

  @Get()
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'branchId', required: false, type: String })
  @ApiQuery({ name: 'action', required: false, type: String })
  @ApiQuery({ name: 'actorUserId', required: false, type: String })
  async list(@Req() request: AuditRequest, @Query() rawQuery: Record<string, unknown>) {
    let query;
    try {
      query = parseCursorPageQuery(rawQuery, ['branchId', 'action', 'actorUserId']);
      for (const key of ['branchId', 'actorUserId'] as const) {
        if (query.filters[key] && !z.uuid().safeParse(query.filters[key]).success) {
          throw new Error(`Invalid query parameter: ${key}`);
        }
      }
      if (query.cursor && !z.iso.datetime({ offset: true }).safeParse(query.cursor.sortValue).success) {
        throw new Error('Invalid query parameter: cursor');
      }
    } catch {
      throw new BadRequestException({ code: 'AUDIT_QUERY_INVALID',
        title: 'Filtros de auditoría inválidos', detail: 'Revisá los filtros de búsqueda.' });
    }
    try {
      return await this.service.list(this.context(request), {
        limit: query.limit, cursor: query.cursor,
        branchId: query.filters.branchId, action: query.filters.action,
        actorUserId: query.filters.actorUserId,
      });
    } catch (error) {
      if (error instanceof AuditAccessError) throw new ForbiddenException({
        code: error.code, title: 'Auditoría no autorizada', detail: error.message,
      });
      throw error;
    }
  }

  private context(request: AuditRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
        ? requestId : randomUUID() };
  }
}
