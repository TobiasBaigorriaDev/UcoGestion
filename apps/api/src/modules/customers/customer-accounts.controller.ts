import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get,
  NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError, IdempotencyReplayPendingError } from '../../core/idempotency/idempotency.service.js';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { IfMatchVersion } from '../../core/validation/if-match.js';
import { parseCursorPageQuery } from '../../core/validation/pagination.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { CashSessionDeviceError, CustomerCollectionCashError } from '../cash/index.js';
import { accountMoneySchema, CustomerAccountError, CustomerAccountService } from './customer-account.service.js';

const limitSchema = z.strictObject({ creditLimit: accountMoneySchema });
const collectionSchema = z.strictObject({ cashSessionId: z.uuid(), deviceId: z.uuid(), amount: accountMoneySchema,
  method: z.enum(['CASH','DEBIT_CARD','CREDIT_CARD','TRANSFER','QR']) });
const reversalSchema = collectionSchema.pick({ cashSessionId: true, deviceId: true }).extend({ reason: z.string().trim().min(1).max(500) });
interface AccountRequest { headers: Record<string, string | string[] | undefined>;
  identity?: { organizationId: string; userId: string } }

@Controller('customers/:customerId/account')
export class CustomerAccountsController {
  constructor(private readonly accounts: CustomerAccountService) {}
  @Get()
  async read(@Req() request: AccountRequest, @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: Record<string, unknown>) {
    const page = parseCursorPageQuery(query, ['branchId']);
    if ((page.filters.branchId && !z.uuid().safeParse(page.filters.branchId).success) ||
      (page.cursor && !z.iso.datetime({ offset: true, precision: 6 }).safeParse(page.cursor.sortValue).success)) {
      throw new BadRequestException({ code: 'CUSTOMER_ACCOUNT_QUERY_INVALID', detail: 'Revisá los filtros de la cuenta.' });
    }
    try { return await this.accounts.read(this.context(request), customerId, { branchId: page.filters.branchId, cursor: page.cursor, limit: page.limit }); }
    catch (error) { this.handle(error); }
  }
  @Patch('limit')
  async setLimit(@Req() request: AccountRequest, @Param('customerId', ParseUUIDPipe) customerId: string,
    @IfMatchVersion() version: number, @Body(new ZodValidationPipe(limitSchema)) body: z.infer<typeof limitSchema>) {
    try { return await this.accounts.setLimit(this.context(request), customerId, version, body.creditLimit, requireIdempotencyKey(request.headers)); }
    catch (error) { this.handle(error); }
  }
  @Post('collections')
  async collect(@Req() request: AccountRequest, @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body(new ZodValidationPipe(collectionSchema)) body: z.infer<typeof collectionSchema>) {
    try { return await this.accounts.collect(this.context(request), customerId, body, requireIdempotencyKey(request.headers)); }
    catch (error) { this.handle(error); }
  }
  @Post('collections/:entryId/reverse')
  async reverse(@Req() request: AccountRequest, @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string, @Body(new ZodValidationPipe(reversalSchema)) body: z.infer<typeof reversalSchema>) {
    try { return await this.accounts.reverseCollection(this.context(request), customerId, entryId, body, requireIdempotencyKey(request.headers)); }
    catch (error) { this.handle(error); }
  }
  private context(request: AccountRequest) {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { ...request.identity, requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : randomUUID() };
  }
  private handle(error: unknown): never {
    if (error instanceof CustomerAccountError || error instanceof CashSessionDeviceError || error instanceof CustomerCollectionCashError) {
      const body = { code: error.code, title: 'Cuenta corriente', detail: error.message };
      if (error.code.endsWith('FORBIDDEN')) throw new ForbiddenException(body);
      if (error.code.endsWith('NOT_FOUND')) throw new NotFoundException(body);
      if (error.code.endsWith('INVALID')) throw new BadRequestException(body);
      throw new ConflictException(body);
    }
    if (error instanceof IdempotencyKeyReusedError) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'La clave ya se usó con otros datos.' });
    if (error instanceof IdempotencyReplayForbiddenError) throw new ForbiddenException({ code: 'IDEMPOTENCY_REPLAY_FORBIDDEN', detail: 'No podés recuperar esta operación.' });
    if (error instanceof IdempotencyReplayPendingError) throw new ConflictException({ code: 'IDEMPOTENCY_REPLAY_PENDING', detail: 'Operación en curso. Reintentá con la misma clave.' });
    throw error;
  }
}
