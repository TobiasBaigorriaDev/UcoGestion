import { randomUUID } from 'node:crypto';

import { BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Post, Req, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError,
  IdempotencyReplayPendingError } from '../../core/idempotency/idempotency.service.js';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashOpeningError } from './cash-opening-preparation.js';
import { CashSessionDeviceError } from './cash-session-device.policy.js';
import { ConcurrentCashModificationError } from './cash-transaction-retry.js';
import { CashMovementError, CashOperationsService } from './cash-operations.service.js';

const openSchema = z.strictObject({ branchId: z.uuid(), cashRegisterId: z.uuid(),
  deviceId: z.uuid(), openingCash: z.string() });
const manualSchema = z.strictObject({ cashSessionId: z.uuid(), deviceId: z.uuid(),
  amount: z.string(), reason: z.string().max(2000) });
interface CashRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('cash-sessions')
export class CashController {
  constructor(private readonly cash: CashOperationsService) {}

  @Post('open')
  async open(@Req() request: CashRequest,
    @Body(new ZodValidationPipe(openSchema)) body: z.infer<typeof openSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.cash.open(this.context(request), body, key); }
    catch (error) { this.handleError(error); }
  }

  @Post('manual-deposits')
  async deposit(@Req() request: CashRequest,
    @Body(new ZodValidationPipe(manualSchema)) body: z.infer<typeof manualSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.cash.deposit(this.context(request), body, key); }
    catch (error) { this.handleError(error); }
  }

  @Post('manual-withdrawals')
  async withdraw(@Req() request: CashRequest,
    @Body(new ZodValidationPipe(manualSchema)) body: z.infer<typeof manualSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.cash.withdraw(this.context(request), body, key); }
    catch (error) { this.handleError(error); }
  }

  private context(request: CashRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
        ? requestId : randomUUID() };
  }

  private handleError(error: unknown): never {
    if (error instanceof ConcurrentCashModificationError) throw new ConflictException({
      code: 'CASH_CONCURRENT_MODIFICATION', title: 'Operación concurrente', detail: 'Intentá nuevamente.' });
    if (error instanceof CashMovementError) throw new ConflictException({
      code: error.code, title: 'Efectivo insuficiente', detail: error.message });
    if (error instanceof CashOpeningError) {
      const body = { code: error.code, title: 'Apertura de caja rechazada', detail: error.message };
      if (error.code === 'CASH_OPENING_FORBIDDEN') throw new ForbiddenException(body);
      if (error.code === 'CASH_OPENING_AMOUNT_INVALID') throw new BadRequestException(body);
      throw new ConflictException(body);
    }
    if (error instanceof CashSessionDeviceError) {
      const body = { code: error.code, title: 'Operación de caja rechazada', detail: error.message };
      if (error.code === 'CASH_SESSION_ACTOR_FORBIDDEN') throw new ForbiddenException(body);
      throw new ConflictException(body);
    }
    if (error instanceof IdempotencyKeyReusedError) throw new ConflictException({
      code: 'IDEMPOTENCY_KEY_REUSED', title: 'Clave reutilizada', detail: 'La clave ya se usó con otros datos.' });
    if (error instanceof IdempotencyReplayForbiddenError) throw new ForbiddenException({
      code: 'IDEMPOTENCY_REPLAY_FORBIDDEN', title: 'Acceso denegado', detail: 'No podés recuperar esta operación.' });
    if (error instanceof IdempotencyReplayPendingError) throw new ConflictException({
      code: 'IDEMPOTENCY_REPLAY_PENDING', title: 'Operación en curso', detail: 'Intentá nuevamente.' });
    if (error instanceof RangeError) throw new BadRequestException({
      code: 'CASH_INPUT_INVALID', title: 'Datos inválidos', detail: error.message });
    throw error;
  }
}
