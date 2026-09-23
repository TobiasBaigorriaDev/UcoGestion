import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';

import { IfMatchVersion } from '../../core/validation/if-match.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import {
  SupplierManagementError,
  SupplierManagementService,
} from './supplier-management.service.js';

const createSupplierSchema = z.strictObject({
  name: z.string().trim().min(1, 'El nombre es obligatorio.').max(255),
  taxId: z.string().trim().max(64).nullable().optional(),
  contact: z.string().trim().max(1000).nullable().optional(),
  address: z.string().trim().max(1000).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const updateSupplierSchema = z.strictObject({
  name: z.string().trim().min(1, 'El nombre es obligatorio.').max(255).optional(),
  taxId: z.string().trim().max(64).nullable().optional(),
  contact: z.string().trim().max(1000).nullable().optional(),
  address: z.string().trim().max(1000).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const statusSchema = z.strictObject({
  status: z.enum(['ACTIVE', 'INACTIVE']),
});

interface SupplierRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly service: SupplierManagementService) {}

  @Post()
  async create(
    @Req() request: SupplierRequest,
    @Body(new ZodValidationPipe(createSupplierSchema)) body: z.infer<typeof createSupplierSchema>,
  ) {
    try {
      return await this.service.create(this.context(request), body);
    } catch (error) {
      this.handleError(error);
    }
  }

  @Get()
  async list(
    @Req() request: SupplierRequest,
    @Query('status') status?: 'ACTIVE' | 'INACTIVE',
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
      return await this.service.list(this.context(request), {
        status,
        search,
        limit: Number.isNaN(parsedLimit) ? undefined : parsedLimit,
      });
    } catch (error) {
      this.handleError(error);
    }
  }

  @Get(':supplierId')
  async findById(
    @Req() request: SupplierRequest,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
  ) {
    try {
      return await this.service.findById(this.context(request), supplierId);
    } catch (error) {
      this.handleError(error);
    }
  }

  @Patch(':supplierId')
  async update(
    @Req() request: SupplierRequest,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
    @IfMatchVersion() expectedVersion: number,
    @Body(new ZodValidationPipe(updateSupplierSchema)) body: z.infer<typeof updateSupplierSchema>,
  ) {
    try {
      return await this.service.update(this.context(request), supplierId, expectedVersion, body);
    } catch (error) {
      this.handleError(error);
    }
  }

  @Patch(':supplierId/status')
  async changeStatus(
    @Req() request: SupplierRequest,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
    @IfMatchVersion() expectedVersion: number,
    @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    try {
      return await this.service.changeStatus(this.context(request), supplierId, expectedVersion, body.status);
    } catch (error) {
      this.handleError(error);
    }
  }

  @Delete(':supplierId')
  async deletePhysically(
    @Req() request: SupplierRequest,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
    @IfMatchVersion() expectedVersion: number,
  ) {
    try {
      return await this.service.deletePhysically(this.context(request), supplierId, expectedVersion);
    } catch (error) {
      this.handleError(error);
    }
  }

  private context(request: SupplierRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return {
      organizationId: request.identity.organizationId,
      userId: request.identity.userId,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
        ? requestId : randomUUID(),
    };
  }

  private handleError(error: unknown): never {
    if (!(error instanceof SupplierManagementError)) {
      throw error;
    }
    const body = {
      code: error.code,
      detail: error.message,
      title: 'Operación de proveedor rechazada',
      ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
    };
    if (error.code.endsWith('_FORBIDDEN')) throw new ForbiddenException(body);
    if (error.code.endsWith('_NOT_FOUND')) throw new NotFoundException(body);
    if (error.code.endsWith('_INVALID')) throw new BadRequestException(body);
    throw new ConflictException(body);
  }
}
