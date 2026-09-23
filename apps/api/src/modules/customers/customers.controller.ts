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
import { ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

import { IfMatchVersion } from '../../core/validation/if-match.js';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { parseMasterListQuery } from '../../core/validation/master-list-query.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import {
  CustomerManagementError,
  CustomerManagementService,
} from './customer-management.service.js';

const createCustomerSchema = z.strictObject({
  name: z.string().trim().min(1, 'El nombre es obligatorio.').max(255),
  taxId: z.string().trim().max(64).nullable().optional(),
  contact: z.string().trim().max(1000).nullable().optional(),
  address: z.string().trim().max(1000).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const updateCustomerSchema = z.strictObject({
  name: z.string().trim().min(1, 'El nombre es obligatorio.').max(255).optional(),
  taxId: z.string().trim().max(64).nullable().optional(),
  contact: z.string().trim().max(1000).nullable().optional(),
  address: z.string().trim().max(1000).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const statusSchema = z.strictObject({
  status: z.enum(['ACTIVE', 'INACTIVE']),
});

interface CustomerRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('customers')
export class CustomersController {
  constructor(private readonly service: CustomerManagementService) {}

  @Post()
  async create(
    @Req() request: CustomerRequest,
    @Body(new ZodValidationPipe(createCustomerSchema)) body: z.infer<typeof createCustomerSchema>,
  ) {
    try {
      return await this.service.create(this.context(request), body, requireIdempotencyKey(request.headers));
    } catch (error) {
      this.handleError(error);
    }
  }

  @Get()
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'INACTIVE'] })
  async list(
    @Req() request: CustomerRequest,
    @Query() query: Record<string, unknown>,
  ) {
    try {
      return await this.service.list(this.context(request), parseMasterListQuery(query));
    } catch (error) {
      this.handleError(error);
    }
  }

  @Get(':customerId')
  async findById(
    @Req() request: CustomerRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    try {
      return await this.service.findById(this.context(request), customerId);
    } catch (error) {
      this.handleError(error);
    }
  }

  @Patch(':customerId')
  async update(
    @Req() request: CustomerRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @IfMatchVersion() expectedVersion: number,
    @Body(new ZodValidationPipe(updateCustomerSchema)) body: z.infer<typeof updateCustomerSchema>,
  ) {
    try {
      return await this.service.update(this.context(request), customerId, expectedVersion, body,
        requireIdempotencyKey(request.headers));
    } catch (error) {
      this.handleError(error);
    }
  }

  @Patch(':customerId/status')
  async changeStatus(
    @Req() request: CustomerRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @IfMatchVersion() expectedVersion: number,
    @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    try {
      return await this.service.changeStatus(this.context(request), customerId, expectedVersion, body.status,
        requireIdempotencyKey(request.headers));
    } catch (error) {
      this.handleError(error);
    }
  }

  @Delete(':customerId')
  async deletePhysically(
    @Req() request: CustomerRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @IfMatchVersion() expectedVersion: number,
  ) {
    try {
      return await this.service.deletePhysically(this.context(request), customerId, expectedVersion,
        requireIdempotencyKey(request.headers));
    } catch (error) {
      this.handleError(error);
    }
  }

  private context(request: CustomerRequest): TenantTransactionContext {
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
    if (!(error instanceof CustomerManagementError)) {
      throw error;
    }
    const body = {
      code: error.code,
      detail: error.message,
      title: 'Operación de cliente rechazada',
      ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
    };
    if (error.code.endsWith('_FORBIDDEN')) throw new ForbiddenException(body);
    if (error.code.endsWith('_NOT_FOUND')) throw new NotFoundException(body);
    if (error.code.endsWith('_INVALID')) throw new BadRequestException(body);
    throw new ConflictException(body);
  }
}
