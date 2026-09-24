import { randomUUID } from 'node:crypto';

import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Post, Req, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError, IdempotencyReplayPendingError } from '../../core/idempotency/idempotency.service.js';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { BranchManagementError, BranchManagementService } from './branch-management.service.js';
import { BranchReadService } from './branch-read.service.js';

const createSchema = z.strictObject({ name: z.string().trim().min(1).max(255) });
interface BranchRequest { readonly headers: Record<string, string | string[] | undefined>; identity?: { readonly organizationId: string; readonly userId: string } }

@Controller('branches')
export class BranchesController {
  constructor(private readonly reader: BranchReadService, private readonly management: BranchManagementService) {}

  @Get()
  read(@Req() request: BranchRequest): Promise<unknown> { return this.reader.read(this.context(request)); }

  @Post()
  async create(@Req() request: BranchRequest, @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.management.create(this.context(request), body, key); }
    catch (error) {
      if (error instanceof BranchManagementError) {
        const response = { code: error.code, title: 'Operación de sucursal rechazada', detail: error.message };
        if (error.code.endsWith('_FORBIDDEN')) throw new ForbiddenException(response);
        if (error.code.endsWith('_INVALID')) throw new BadRequestException(response);
        throw new ConflictException(response);
      }
      if (error instanceof IdempotencyKeyReusedError) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', title: 'Clave reutilizada', detail: 'La clave ya se usó con otros datos.' });
      if (error instanceof IdempotencyReplayForbiddenError) throw new ForbiddenException({ code: 'IDEMPOTENCY_REPLAY_FORBIDDEN', title: 'Acceso denegado', detail: 'No podés recuperar esta operación.' });
      if (error instanceof IdempotencyReplayPendingError) throw new ConflictException({ code: 'IDEMPOTENCY_REPLAY_PENDING', title: 'Operación en curso', detail: 'La operación sigue en curso. Intentá nuevamente.' });
      throw error;
    }
  }

  private context(request: BranchRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId, requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : randomUUID() };
  }
}
