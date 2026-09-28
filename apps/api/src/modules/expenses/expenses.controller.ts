import { randomUUID } from 'node:crypto';

import { BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Post, Req, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError,
  IdempotencyReplayPendingError } from '../../core/idempotency/idempotency.service.js';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDeviceError } from '../cash/index.js';
import { ExpenseCategorySelectionError } from './expense-category-selection.policy.js';
import { ExpenseCashBalanceError, ExpenseOperationsService } from './expense-operations.service.js';
import { ExpensePersistenceError } from './expense-persistence.js';
import { ExpenseAuthorizationError } from './expense-policy.js';

const expenseSchema = z.strictObject({ branchId: z.uuid(), categoryId: z.uuid(),
  concept: z.string(), amount: z.string(), method: z.string(),
  cashSessionId: z.uuid().optional(), deviceId: z.uuid().optional() });
interface ExpenseRequest { readonly headers: Record<string, string | string[] | undefined>;
  identity?: { readonly organizationId: string; readonly userId: string } }

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly operations: ExpenseOperationsService) {}

  @Post()
  async create(@Req() request: ExpenseRequest,
    @Body(new ZodValidationPipe(expenseSchema)) body: z.infer<typeof expenseSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.operations.create(this.context(request), body, key); }
    catch (error) { this.handleError(error); }
  }

  private context(request: ExpenseRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
        ? requestId : randomUUID() };
  }

  private handleError(error: unknown): never {
    if (error instanceof ExpenseAuthorizationError || error instanceof IdempotencyReplayForbiddenError) {
      throw new ForbiddenException({ code: error instanceof ExpenseAuthorizationError
        ? error.code : 'IDEMPOTENCY_REPLAY_FORBIDDEN', title: 'Gasto no autorizado', detail: error.message });
    }
    if (error instanceof ExpensePersistenceError) {
      const body = { code: error.code, title: 'Gasto inválido', detail: error.message };
      if (error.code === 'EXPENSE_AMOUNT_INVALID' || error.code === 'EXPENSE_CONCEPT_INVALID') throw new BadRequestException(body);
      throw new ConflictException(body);
    }
    if (error instanceof ExpenseCategorySelectionError || error instanceof ExpenseCashBalanceError
      || error instanceof CashSessionDeviceError) {
      throw new ConflictException({ code: error.code, title: 'Gasto rechazado', detail: error.message });
    }
    if (error instanceof IdempotencyKeyReusedError || error instanceof IdempotencyReplayPendingError) {
      throw new ConflictException({ code: error instanceof IdempotencyKeyReusedError
        ? 'IDEMPOTENCY_KEY_REUSED' : 'IDEMPOTENCY_REPLAY_PENDING', title: 'Gasto duplicado', detail: error.message });
    }
    throw error;
  }
}
