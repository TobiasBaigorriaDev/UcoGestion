import { randomUUID } from 'node:crypto';

import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get,
  HttpException, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Put, Req,
  UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError,
  IdempotencyReplayPendingError } from '../../core/idempotency/idempotency.service.js';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { InventoryAdjustmentService } from './inventory-adjustment.service.js';
import { ConcurrentInventoryModificationError } from './inventory-transaction-retry.js';
import { InventoryTransferService } from './inventory-transfer.service.js';
import { StockThresholdService } from './stock-threshold.service.js';

const adjustmentSchema = z.strictObject({
  branchId: z.uuid(), itemId: z.uuid(), direction: z.enum(['INCREASE', 'DECREASE']),
  quantity: z.string(), reason: z.enum(['INVENTARIO_INICIAL', 'CONTEO_FISICO', 'ROTURA',
    'PERDIDA', 'VENCIMIENTO', 'CORRECCION', 'OTRO']), observation: z.string().max(2000).nullable().optional(),
});
const compensationSchema = z.strictObject({ observation: z.string().max(2000).nullable().optional() });
const thresholdSchema = z.strictObject({ minimum: z.string().nullable() });
const transferSchema = z.strictObject({ originBranchId: z.uuid(), destinationBranchId: z.uuid(),
  lines: z.array(z.strictObject({ itemId: z.uuid(), quantity: z.string() })).min(1).max(100) });
interface InventoryRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('inventory')
export class InventoryController {
  constructor(private readonly adjustments: InventoryAdjustmentService,
    private readonly thresholds: StockThresholdService,
    private readonly transfers: InventoryTransferService) {}

  @Post('transfers')
  async transfer(@Req() request: InventoryRequest,
    @Body(new ZodValidationPipe(transferSchema)) body: z.infer<typeof transferSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.transfers.confirm(this.context(request), body, key); }
    catch (error) { this.handleError(error); }
  }

  @Post('transfers/:id/compensations')
  async compensateTransfer(@Req() request: InventoryRequest,
    @Param('id', ParseUUIDPipe) id: string) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.transfers.compensate(this.context(request), id, key); }
    catch (error) { this.handleError(error); }
  }

  @Get('stocks/:branchId/:itemId')
  async stock(@Req() request: InventoryRequest,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string) {
    try { return await this.thresholds.read(this.context(request), branchId, itemId); }
    catch (error) { this.handleError(error); }
  }

  @Put('stocks/:branchId/:itemId/threshold')
  async threshold(@Req() request: InventoryRequest,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body(new ZodValidationPipe(thresholdSchema)) body: z.infer<typeof thresholdSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.thresholds.set(this.context(request), branchId, itemId, body.minimum, key); }
    catch (error) { this.handleError(error); }
  }

  @Post('adjustments')
  async adjust(@Req() request: InventoryRequest,
    @Body(new ZodValidationPipe(adjustmentSchema)) body: z.infer<typeof adjustmentSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.adjustments.confirm(this.context(request), { ...body, observation: body.observation ?? null }, key); }
    catch (error) { this.handleError(error); }
  }

  @Post('adjustments/:id/compensations')
  async compensate(@Req() request: InventoryRequest, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(compensationSchema)) body: z.infer<typeof compensationSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.adjustments.compensate(this.context(request), id, body.observation ?? null, key); }
    catch (error) { this.handleError(error); }
  }

  private context(request: InventoryRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : randomUUID() };
  }

  private handleError(error: unknown): never {
    if (error instanceof ConcurrentInventoryModificationError) throw new ConflictException({
      code: 'CONCURRENT_MODIFICATION', title: 'Operación concurrente', detail: 'Intentá nuevamente.' });
    if (error instanceof IdempotencyKeyReusedError) throw new ConflictException({
      code: 'IDEMPOTENCY_KEY_REUSED', title: 'Clave reutilizada', detail: 'La clave ya se usó con otros datos.' });
    if (error instanceof IdempotencyReplayForbiddenError) throw new ForbiddenException({
      code: 'IDEMPOTENCY_REPLAY_FORBIDDEN', title: 'Acceso denegado', detail: 'No podés recuperar esta operación.' });
    if (error instanceof IdempotencyReplayPendingError) throw new ConflictException({
      code: 'IDEMPOTENCY_REPLAY_PENDING', title: 'Operación en curso', detail: 'Intentá nuevamente.' });
    if (error instanceof RangeError || error instanceof TypeError) throw new BadRequestException({
      code: 'INVENTORY_ADJUSTMENT_INVALID', title: 'Ajuste inválido', detail: error.message });
    if (error instanceof Error && /no autorizado|no autorizada|forbidden/.test(error.message)) throw new ForbiddenException({
      code: 'INVENTORY_ADJUSTMENT_FORBIDDEN', title: 'Acceso denegado', detail: 'No tenés permiso para ajustar esta sucursal.' });
    if (error instanceof Error && /no disponible/.test(error.message)) throw new NotFoundException({
      code: 'INVENTORY_ADJUSTMENT_NOT_FOUND', title: 'Ajuste no disponible', detail: 'El recurso solicitado no está disponible.' });
    if (error instanceof Error && /insufficient stock|stock insuficiente|insufficient transfer stock/i.test(error.message)) throw new ConflictException({
      code: 'INSUFFICIENT_STOCK', title: 'Stock insuficiente', detail: 'Revisá el stock disponible antes de confirmar.' });
    if (error instanceof Error && /stock_transfer_compensations_pkey|invalid transfer compensation|Transferencia ya compensada/.test(error.message)) throw new ConflictException({
      code: 'TRANSFER_ALREADY_COMPENSATED', title: 'Transferencia ya compensada',
      detail: 'Esta transferencia no admite otra compensación.' });
    if (error instanceof Error && /duplicate key/.test(error.message)) throw new ConflictException({
      code: 'ADJUSTMENT_ALREADY_COMPENSATED', title: 'Ajuste ya compensado', detail: 'Este ajuste ya tiene una compensación.' });
    throw error instanceof HttpException ? error : new HttpException({
      code: 'INVENTORY_ADJUSTMENT_FAILED', title: 'Ajuste rechazado', detail: 'No se pudo confirmar el ajuste.' }, HttpStatus.CONFLICT);
  }
}
