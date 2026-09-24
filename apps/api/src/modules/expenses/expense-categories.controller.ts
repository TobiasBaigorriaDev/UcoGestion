import { randomUUID } from 'node:crypto';

import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException,
  Get, HttpException, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req,
  UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { IfMatchVersion } from '../../core/validation/if-match.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { ExpenseCategoryManagementError, ExpenseCategoryManagementService } from './expense-category-management.service.js';

const nameSchema = z.strictObject({ name: z.string().trim().min(1).max(255) });
const statusSchema = z.strictObject({ status: z.enum(['ACTIVE', 'INACTIVE']) });
interface ExpenseRequest { readonly headers: Record<string, string | string[] | undefined>; identity?: { readonly organizationId: string; readonly userId: string } }

@Controller('expense-categories')
export class ExpenseCategoriesController {
  constructor(private readonly categories: ExpenseCategoryManagementService) {}

  @Get()
  async list(@Req() request: ExpenseRequest) {
    try { return { categories: await this.categories.list(this.context(request)) }; }
    catch (error) { this.handleError(error); }
  }

  @Get('active')
  async listActive(@Req() request: ExpenseRequest) {
    try { return { categories: (await this.categories.list(this.context(request))).filter((category) => category.status === 'ACTIVE') }; }
    catch (error) { this.handleError(error); }
  }

  @Post()
  async create(@Req() request: ExpenseRequest,
    @Body(new ZodValidationPipe(nameSchema)) body: z.infer<typeof nameSchema>) {
    try { return await this.categories.create(this.context(request), body, this.idempotencyKey(request)); }
    catch (error) { this.handleError(error); }
  }

  @Patch(':id/status')
  async changeStatus(@Req() request: ExpenseRequest, @Param('id', ParseUUIDPipe) id: string,
    @IfMatchVersion() version: number, @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>) {
    try { return await this.categories.changeStatus(this.context(request), id, version, body.status, this.idempotencyKey(request)); }
    catch (error) { this.handleError(error); }
  }

  @Delete(':id')
  async remove(@Req() request: ExpenseRequest, @Param('id', ParseUUIDPipe) id: string,
    @IfMatchVersion() version: number) {
    try { return await this.categories.deletePhysically(this.context(request), id, version, this.idempotencyKey(request)); }
    catch (error) { this.handleError(error); }
  }

  private context(request: ExpenseRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : randomUUID() };
  }

  private idempotencyKey(request: ExpenseRequest): string {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) {
      throw new HttpException({ code: 'IDEMPOTENCY_KEY_REQUIRED', title: 'Precondición requerida',
        detail: 'Enviá una clave Idempotency-Key válida.' }, HttpStatus.PRECONDITION_REQUIRED);
    }
    return key;
  }

  private handleError(error: unknown): never {
    if (!(error instanceof ExpenseCategoryManagementError)) throw error;
    const body = { code: error.code, title: 'Categoría de gasto rechazada', detail: error.message,
      ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) };
    if (error.code.endsWith('_FORBIDDEN')) throw new ForbiddenException(body);
    if (error.code.endsWith('_NOT_FOUND')) throw new NotFoundException(body);
    if (error.code.endsWith('_INVALID')) throw new BadRequestException(body);
    throw new ConflictException(body);
  }
}
