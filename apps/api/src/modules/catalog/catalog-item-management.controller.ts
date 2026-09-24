import { randomUUID } from 'node:crypto';

import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get,
  HttpException, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req,
  UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { IfMatchVersion } from '../../core/validation/if-match.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CatalogItemCreationError, CatalogItemCreationService } from './catalog-item-creation.service.js';
import { CatalogItemEditError, CatalogItemEditService } from './catalog-item-edit.service.js';
import { CatalogPriceError, CatalogPriceService } from './catalog-price.service.js';

const itemSchema = z.strictObject({ name: z.string().trim().min(1).max(255),
  type: z.enum(['PRODUCT', 'SERVICE']), trackInventory: z.boolean().optional(),
  baseUnit: z.enum(['UNIT', 'FRACTIONAL']).optional(),
  sku: z.string().nullable().optional(), barcode: z.string().nullable().optional() });
const editSchema = z.strictObject({ name: z.string().trim().min(1).max(255),
  sku: z.string().nullable(), barcode: z.string().nullable() });
const priceSchema = z.strictObject({ price: z.string() });
interface CatalogRequest { readonly headers: Record<string, string | string[] | undefined>; identity?: { readonly organizationId: string; readonly userId: string } }

@Controller('catalog/items')
export class CatalogItemManagementController {
  constructor(private readonly creation: CatalogItemCreationService,
    private readonly editing: CatalogItemEditService, private readonly prices: CatalogPriceService) {}

  @Post()
  async create(@Req() request: CatalogRequest,
    @Body(new ZodValidationPipe(itemSchema)) body: z.infer<typeof itemSchema>) {
    try { return await this.creation.createIdempotent(this.context(request), {
      name: body.name, type: body.type,
      ...(body.trackInventory === undefined ? {} : { trackInventory: body.trackInventory }),
      ...(body.baseUnit === undefined ? {} : { baseUnit: body.baseUnit }),
      ...(body.sku === undefined ? {} : { sku: body.sku }),
      ...(body.barcode === undefined ? {} : { barcode: body.barcode }),
    }, this.key(request)); }
    catch (error) { this.handleError(error); }
  }

  @Get('similar')
  async similar(@Req() request: CatalogRequest, @Query('name') name?: string) {
    if (!name || name.length > 255) return { names: [] };
    try { return { names: await this.creation.findSimilarNames(this.context(request), name) }; }
    catch (error) { this.handleError(error); }
  }

  @Patch(':id')
  async edit(@Req() request: CatalogRequest, @Param('id', ParseUUIDPipe) id: string,
    @IfMatchVersion() version: number,
    @Body(new ZodValidationPipe(editSchema)) body: z.infer<typeof editSchema>) {
    try { return await this.editing.update(this.context(request), id, version, body, this.key(request)); }
    catch (error) { this.handleError(error); }
  }

  @Patch(':id/price')
  async price(@Req() request: CatalogRequest, @Param('id', ParseUUIDPipe) id: string,
    @IfMatchVersion() version: number,
    @Body(new ZodValidationPipe(priceSchema)) body: z.infer<typeof priceSchema>) {
    try { return await this.prices.setPriceIdempotent(this.context(request), id, version, body.price, this.key(request)); }
    catch (error) { this.handleError(error); }
  }

  private context(request: CatalogRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : randomUUID() };
  }

  private key(request: CatalogRequest): string {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) {
      throw new HttpException({ code: 'IDEMPOTENCY_KEY_REQUIRED', title: 'Precondición requerida',
        detail: 'Enviá una clave Idempotency-Key válida.' }, HttpStatus.PRECONDITION_REQUIRED);
    }
    return key;
  }

  private handleError(error: unknown): never {
    if (!(error instanceof CatalogItemCreationError) && !(error instanceof CatalogItemEditError)
      && !(error instanceof CatalogPriceError)) throw error;
    const body = { code: error.code, title: 'Operación de catálogo rechazada', detail: error.message,
      ...(error instanceof CatalogItemEditError && error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}) };
    if (error.code.endsWith('_FORBIDDEN')) throw new ForbiddenException(body);
    if (error.code.endsWith('_NOT_FOUND')) throw new NotFoundException(body);
    if (error.code.endsWith('_INVALID') || error.code.endsWith('_NOT_ALLOWED')) throw new BadRequestException(body);
    throw new ConflictException(body);
  }
}
