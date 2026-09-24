import { randomUUID } from 'node:crypto';

import { BadRequestException, Controller, Get, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';

import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CatalogReadService } from './catalog-read.service.js';

interface CatalogRequest { readonly headers: Record<string, string | string[] | undefined>; identity?: { readonly organizationId: string; readonly userId: string } }

@Controller('catalog')
export class CatalogReadController {
  constructor(private readonly reader: CatalogReadService) {}

  @Get('items')
  @ApiQuery({ name: 'mode', required: false })
  @ApiQuery({ name: 'branchId', required: false })
  read(@Req() request: CatalogRequest, @Query('mode') mode?: string, @Query('branchId') branchId?: string) {
    if (mode !== undefined || branchId !== undefined) {
      if (mode !== 'HISTORICAL' || !branchId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(branchId)) {
        throw new BadRequestException({ code: 'CATALOG_CONTEXT_INVALID', title: 'Contexto inválido', detail: 'Elegí una sucursal y un contexto histórico válido.' });
      }
      return this.reader.read(this.context(request), { mode, branchId });
    }
    return this.reader.read(this.context(request));
  }

  @Get('categories')
  readCategories(@Req() request: CatalogRequest) {
    return this.reader.readManagedCategories(this.context(request));
  }

  @Get('items/manage')
  readManagedItems(@Req() request: CatalogRequest) {
    return this.reader.readManagedItems(this.context(request));
  }

  private context(request: CatalogRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId, requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : randomUUID() };
  }
}
