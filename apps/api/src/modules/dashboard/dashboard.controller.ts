import { randomUUID } from 'node:crypto';

import { BadRequestException, Controller, ForbiddenException, Get, Query, Req,
  UnauthorizedException } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { DashboardAccessError, DashboardService } from './dashboard.service.js';

const querySchema = z.strictObject({
  branchId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

interface DashboardRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get()
  @ApiQuery({ name: 'branchId', required: false, type: String })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  async get(@Req() request: DashboardRequest, @Query() rawQuery: Record<string, unknown>) {
    const parsed = querySchema.safeParse(rawQuery);
    if (!parsed.success || (parsed.data.from && parsed.data.to &&
      Date.parse(parsed.data.from) >= Date.parse(parsed.data.to))) {
      throw new BadRequestException({ code: 'DASHBOARD_QUERY_INVALID',
        title: 'Filtros inválidos', detail: 'Revisá el período y la sucursal.' });
    }
    try { return await this.service.get(this.context(request), parsed.data); }
    catch (error) {
      if (error instanceof DashboardAccessError) throw new ForbiddenException({
        code: error.code, title: 'Dashboard no autorizado', detail: error.message,
      });
      throw error;
    }
  }

  private context(request: DashboardRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
        ? requestId : randomUUID() };
  }
}
