import { randomUUID } from 'node:crypto';

import { BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError,
  IdempotencyReplayPendingError } from '../../core/idempotency/idempotency.service.js';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDeviceError } from '../cash/index.js';
import { PurchaseCancellationError } from './purchase-cancellation-preparation.js';
import { ConcurrentPurchaseModificationError,
  PurchaseCashBalanceError, PurchaseOperationsService, PurchasePaymentError } from './purchase-operations.service.js';
import { PurchasePersistenceError } from './purchase-persistence.js';
import { PurchaseAuthorizationError } from './purchase-policy.js';

const confirmationSchema = z.strictObject({
  branchId: z.uuid(), supplierId: z.uuid(), clientOperationId: z.uuid(),
  lines: z.array(z.strictObject({ itemId: z.uuid(), quantity: z.string(),
    unitCost: z.string() })).min(1),
});
const paymentSchema = z.strictObject({ method: z.string().min(1), amount: z.string(),
  cashSessionId: z.uuid().optional(), deviceId: z.uuid().optional() });
const paidConfirmationSchema = confirmationSchema.extend({ payment: paymentSchema.nullable().optional() });
const cancellationSchema = z.strictObject({ reason: z.string(),
  cashSessionId: z.uuid().optional(), deviceId: z.uuid().optional() });

interface PurchasesRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchaseOperationsService) {}

  @Post()
  async confirmPending(@Req() request: PurchasesRequest,
    @Body(new ZodValidationPipe(confirmationSchema)) body: z.infer<typeof confirmationSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.purchases.confirmPending(this.context(request), body, key); }
    catch (error) { this.handleError(error); }
  }

  @Post('paid')
  async confirmPaid(@Req() request: PurchasesRequest,
    @Body(new ZodValidationPipe(paidConfirmationSchema)) body: z.infer<typeof paidConfirmationSchema>) {
    const key = requireIdempotencyKey(request.headers);
    const { payment, ...input } = body;
    try { return await this.purchases.preparePaid(this.context(request), input, payment ?? null, key); }
    catch (error) { this.handleError(error); }
  }

  @Post(':id/pay')
  async pay(@Req() request: PurchasesRequest, @Param('id') id: string,
    @Body(new ZodValidationPipe(paymentSchema)) body: z.infer<typeof paymentSchema>) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException();
    const key = requireIdempotencyKey(request.headers);
    try { return await this.purchases.preparePendingPayment(this.context(request), id, body, key); }
    catch (error) { this.handleError(error); }
  }

  @Post(':id/cancel')
  async cancel(@Req() request: PurchasesRequest, @Param('id') id: string,
    @Body(new ZodValidationPipe(cancellationSchema)) body: z.infer<typeof cancellationSchema>) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException();
    const key = requireIdempotencyKey(request.headers);
    try { return await this.purchases.cancel(this.context(request), id, body, key); }
    catch (error) { this.handleError(error); }
  }

  private context(request: PurchasesRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
        ? requestId : randomUUID() };
  }

  private handleError(error: unknown): never {
    if (error instanceof PurchaseAuthorizationError || error instanceof IdempotencyReplayForbiddenError) {
      throw new ForbiddenException({ code: error instanceof PurchaseAuthorizationError
        ? error.code : 'IDEMPOTENCY_REPLAY_FORBIDDEN', title: 'Compra no autorizada', detail: error.message });
    }
    if (error instanceof PurchasePersistenceError) {
      const body = { code: error.code, title: 'Compra inválida', detail: error.message };
      if (error.code === 'PURCHASE_LINE_INVALID' || error.code === 'PURCHASE_TOTAL_OUT_OF_RANGE') {
        throw new BadRequestException(body);
      }
      throw new ConflictException(body);
    }
    if (error instanceof PurchasePaymentError) throw new BadRequestException({
      code: error.code, title: 'Pago inválido', detail: error.message });
    if (error instanceof PurchaseCancellationError) {
      const body = { code: error.code, title: 'Anulación rechazada', detail: error.message };
      if (error.code === 'PURCHASE_CANCELLATION_REASON_REQUIRED') throw new BadRequestException(body);
      throw new ConflictException(body);
    }
    if (error instanceof PurchaseCashBalanceError || error instanceof CashSessionDeviceError) {
      throw new ConflictException({ code: error.code, title: 'Caja no disponible', detail: error.message });
    }
    if (error instanceof IdempotencyKeyReusedError || error instanceof IdempotencyReplayPendingError
      || error instanceof ConcurrentPurchaseModificationError) {
      throw new ConflictException({ code: error instanceof IdempotencyKeyReusedError
        ? 'IDEMPOTENCY_KEY_REUSED' : error instanceof IdempotencyReplayPendingError
          ? 'IDEMPOTENCY_REPLAY_PENDING' : error.code,
      title: 'Compra en conflicto', detail: error.message });
    }
    throw error;
  }
}
