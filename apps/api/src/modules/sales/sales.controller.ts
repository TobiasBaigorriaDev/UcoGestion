import { randomUUID } from 'node:crypto';

import { BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Get, Header, NotFoundException, Param, Post, Query, Req, StreamableFile,
  UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError,
  IdempotencyReplayPendingError } from '../../core/idempotency/idempotency.service.js';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDeviceError } from '../cash/index.js';
import { SaleCancellationError, SaleCashRefundError } from './sale-cancellation-preparation.js';
import { ConcurrentSaleModificationError, SaleCheckoutContextError,
  SalesOperationsService } from './sales-operations.service.js';
import { PriceChangedError } from './sales-price-acceptance.js';
import { SaleCustomerError, SalePaymentError, SaleSessionBranchError,
  SaleStockError } from './sales-persistence.js';
import { SalesQuoteError } from './sales-quote.service.js';
import { renderReceiptHtml, renderReceiptPdf } from './receipt-renderer.js';

const linesSchema = z.array(z.strictObject({ itemId: z.uuid(), quantity: z.string() })).min(1);
const discountSchema = z.strictObject({ kind: z.enum(['PERCENTAGE', 'FIXED']), value: z.string() });
const quoteSchema = z.strictObject({ branchId: z.uuid(), lines: linesSchema,
  discount: discountSchema.optional() });
const confirmationSchema = quoteSchema.extend({ cashSessionId: z.uuid(), deviceId: z.uuid(),
  clientOperationId: z.uuid(), customerId: z.uuid().nullable().optional(),
  payments: z.array(z.strictObject({ method: z.string().min(1), appliedAmount: z.string(),
    receivedAmount: z.string().optional() })),
  quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/), previousKey: z.string().optional(),
  acceptedPriceChange: z.literal(true).optional() });
const cancellationSchema = z.strictObject({ reason: z.string(), cashSessionId: z.uuid().optional(),
  deviceId: z.uuid().optional() });

interface SalesRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesOperationsService) {}

  @Get('checkout-context')
  async checkoutContext(@Req() request: SalesRequest, @Query('branchId') branchId?: string) {
    if (!branchId || !z.uuid().safeParse(branchId).success) throw new BadRequestException();
    try { return await this.sales.checkoutContext(this.context(request), branchId); }
    catch (error) { this.handleError(error); }
  }

  @Get(':id')
  async detail(@Req() request: SalesRequest, @Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException();
    const sale = await this.sales.detail(this.context(request), id);
    if (!sale) throw new NotFoundException({ code: 'SALE_NOT_FOUND', title: 'Venta no encontrada',
      detail: 'No encontramos esa venta en tu sucursal.' });
    return sale;
  }

  @Get(':id/receipt')
  async receipt(@Req() request: SalesRequest, @Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException();
    const receipt = await this.sales.receipt(this.context(request), id);
    if (!receipt) throw new NotFoundException();
    return receipt;
  }

  @Get(':id/receipt/print')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async printableReceipt(@Req() request: SalesRequest, @Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException();
    const receipt = await this.sales.receipt(this.context(request), id);
    if (!receipt) throw new NotFoundException();
    return renderReceiptHtml(receipt);
  }

  @Get(':id/receipt.pdf')
  async receiptPdf(@Req() request: SalesRequest, @Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException();
    const receipt = await this.sales.receipt(this.context(request), id);
    if (!receipt) throw new NotFoundException();
    const bytes = await renderReceiptPdf(receipt);
    return new StreamableFile(Buffer.from(bytes), { type: 'application/pdf',
      disposition: `attachment; filename="comprobante-${id}.pdf"` });
  }

  @Post('quote')
  async quote(@Req() request: SalesRequest,
    @Body(new ZodValidationPipe(quoteSchema)) body: z.infer<typeof quoteSchema>) {
    try { return await this.sales.quote(this.context(request), body.branchId, body.lines, body.discount); }
    catch (error) { this.handleError(error); }
  }

  @Post()
  async confirm(@Req() request: SalesRequest,
    @Body(new ZodValidationPipe(confirmationSchema)) body: z.infer<typeof confirmationSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.sales.confirm(this.context(request), body, key); }
    catch (error) { this.handleError(error); }
  }

  @Post(':id/cancel')
  async cancel(@Req() request: SalesRequest, @Param('id') id: string,
    @Body(new ZodValidationPipe(cancellationSchema)) body: z.infer<typeof cancellationSchema>) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException();
    const key = requireIdempotencyKey(request.headers);
    try { return await this.sales.cancel(this.context(request), id, body, key); }
    catch (error) { this.handleError(error); }
  }

  private context(request: SalesRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
        ? requestId : randomUUID() };
  }

  private handleError(error: unknown): never {
    if (error instanceof SaleCheckoutContextError) throw new ForbiddenException({
      code: error.code, title: 'Caja no disponible', detail: error.message });
    if (error instanceof SaleCancellationError) {
      const body = { code: error.code, title: 'Anulación rechazada', detail: error.message };
      if (error.code === 'SALE_CANCELLATION_FORBIDDEN') throw new ForbiddenException(body);
      if (error.code === 'SALE_CANCELLATION_NOT_AVAILABLE') throw new NotFoundException(body);
      if (error.code === 'SALE_CANCELLATION_REASON_REQUIRED') throw new BadRequestException(body);
      throw new ConflictException(body);
    }
    if (error instanceof SaleCashRefundError) throw new ConflictException({
      code: error.code, title: 'Reintegro rechazado', detail: error.message });
    if (error instanceof ConcurrentSaleModificationError) throw new ConflictException({
      code: error.code, title: 'Operación concurrente', detail: error.message });
    if (error instanceof PriceChangedError) throw new ConflictException({ code: error.code,
      title: 'Precio actualizado', detail: error.message, currentTotal: error.quote.total,
      quote: error.quote, quoteFingerprint: error.quoteFingerprint });
    if (error instanceof CashSessionDeviceError) {
      const body = { code: error.code, title: 'Sesión de caja rechazada', detail: error.message };
      if (error.code === 'CASH_SESSION_ACTOR_FORBIDDEN') throw new ForbiddenException(body);
      throw new ConflictException(body);
    }
    if (error instanceof SalePaymentError || error instanceof SalesQuoteError) {
      const body = { code: error.code, title: 'Venta inválida', detail: error.message };
      if (error.code === 'SALE_DISCOUNT_FORBIDDEN') throw new ForbiddenException(body);
      throw new BadRequestException(body);
    }
    if (error instanceof SaleCustomerError || error instanceof SaleSessionBranchError ||
      error instanceof SaleStockError) throw new ConflictException({ code: error.code,
        title: 'Venta rechazada', detail: error.message });
    if (error instanceof IdempotencyKeyReusedError) throw new ConflictException({
      code: 'IDEMPOTENCY_KEY_REUSED', title: 'Clave reutilizada', detail: 'La clave ya se usó con otros datos.' });
    if (error instanceof IdempotencyReplayForbiddenError) throw new ForbiddenException({
      code: 'IDEMPOTENCY_REPLAY_FORBIDDEN', title: 'Acceso denegado', detail: 'No podés recuperar esta operación.' });
    if (error instanceof IdempotencyReplayPendingError) throw new ConflictException({
      code: 'IDEMPOTENCY_REPLAY_PENDING', title: 'Operación en curso', detail: 'Intentá nuevamente.' });
    throw error;
  }
}
