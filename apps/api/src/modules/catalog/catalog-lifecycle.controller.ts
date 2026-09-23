import { randomUUID } from 'node:crypto';

import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException,
  HttpException, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Patch, Req,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';

import { IfMatchVersion } from '../../core/validation/if-match.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import {
  CatalogCategoryManagementError, CatalogCategoryManagementService,
} from './catalog-category-management.service.js';
import { CatalogItemLifecycleService, CatalogItemServiceError } from './catalog-item-lifecycle.service.js';

const statusSchema = z.strictObject({ status: z.enum(['ACTIVE', 'INACTIVE']) });
const structuralSchema = z.strictObject({
  type: z.enum(['PRODUCT', 'SERVICE']),
  trackInventory: z.boolean().optional(),
  baseUnit: z.enum(['UNIT', 'FRACTIONAL']).optional(),
});

interface CatalogRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('catalog')
export class CatalogLifecycleController {
  constructor(
    private readonly items: CatalogItemLifecycleService,
    private readonly categories: CatalogCategoryManagementService,
  ) {}

  @Patch('items/:itemId/status')
  async changeItemStatus(
    @Req() request: CatalogRequest,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @IfMatchVersion() expectedVersion: number,
    @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    try {
      return await this.items.changeStatus(this.context(request), itemId, expectedVersion,
        body.status, this.idempotencyKey(request));
    } catch (error) {
      this.handleError(error);
    }
  }

  @Patch('items/:itemId/structure')
  async changeItemStructure(
    @Req() request: CatalogRequest,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @IfMatchVersion() expectedVersion: number,
    @Body(new ZodValidationPipe(structuralSchema)) body: z.infer<typeof structuralSchema>,
  ) {
    try {
      return await this.items.changeStructural(this.context(request), itemId, expectedVersion,
        {
          type: body.type,
          ...(body.trackInventory === undefined ? {} : { trackInventory: body.trackInventory }),
          ...(body.baseUnit === undefined ? {} : { baseUnit: body.baseUnit }),
        }, this.idempotencyKey(request));
    } catch (error) {
      this.handleError(error);
    }
  }

  @Delete('items/:itemId')
  async deleteItem(
    @Req() request: CatalogRequest,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @IfMatchVersion() expectedVersion: number,
  ) {
    try {
      return await this.items.deletePhysically(this.context(request), itemId, expectedVersion,
        this.idempotencyKey(request));
    } catch (error) {
      this.handleError(error);
    }
  }

  @Patch('categories/:categoryId/status')
  async changeCategoryStatus(
    @Req() request: CatalogRequest,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @IfMatchVersion() expectedVersion: number,
    @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    try {
      return await this.categories.changeStatus(this.context(request), categoryId, expectedVersion,
        body.status, this.idempotencyKey(request));
    } catch (error) {
      this.handleError(error);
    }
  }

  @Delete('categories/:categoryId')
  async deleteCategory(
    @Req() request: CatalogRequest,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @IfMatchVersion() expectedVersion: number,
  ) {
    try {
      return await this.categories.deletePhysically(this.context(request), categoryId, expectedVersion,
        this.idempotencyKey(request));
    } catch (error) {
      this.handleError(error);
    }
  }

  private context(request: CatalogRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return {
      organizationId: request.identity.organizationId,
      userId: request.identity.userId,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
        ? requestId : randomUUID(),
    };
  }

  private idempotencyKey(request: CatalogRequest): string {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) {
      throw new HttpException({
        code: 'IDEMPOTENCY_KEY_REQUIRED', title: 'Precondición requerida',
        detail: 'Enviá una clave Idempotency-Key válida.',
      }, HttpStatus.PRECONDITION_REQUIRED);
    }
    return key;
  }

  private handleError(error: unknown): never {
    if (!(error instanceof CatalogItemServiceError) && !(error instanceof CatalogCategoryManagementError)) {
      throw error;
    }
    const body = {
      code: error.code,
      detail: error.message,
      title: 'Operación de catálogo rechazada',
      ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
    };
    if (error.code.endsWith('_FORBIDDEN')) throw new ForbiddenException(body);
    if (error.code.endsWith('_NOT_FOUND')) throw new NotFoundException(body);
    if (error.code.endsWith('_INVALID') || error.code.endsWith('_NOT_ALLOWED')) {
      throw new BadRequestException(body);
    }
    throw new ConflictException(body);
  }
}
