import { randomUUID } from 'node:crypto';

import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Param, ParseUUIDPipe, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { IfMatchVersion } from '../../core/validation/if-match.js';
import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError, IdempotencyReplayPendingError } from '../../core/idempotency/idempotency.service.js';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { InvitationCreationPolicyError, InvitationCreationService } from './invitation-creation.service.js';
import { InvitationRevocationError, InvitationRevocationService } from './invitation-revocation.service.js';
import { InvitationResendError, InvitationResendService } from './invitation-resend.service.js';
import { MembershipAdministrationError, MembershipAdministrationService } from './membership-administration.service.js';
import { NonOwnerMembershipPolicyError } from './non-owner-membership.policy.js';
import { UserManagementReadService } from './user-management-read.service.js';

const role = z.enum(['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE']);
const inviteSchema = z.strictObject({ email: z.email(), role, branchIds: z.array(z.uuid()) });
const roleChangeSchema = z.strictObject({ role, branchIds: z.array(z.uuid()) });
const statusSchema = z.strictObject({ status: z.enum(['ACTIVE', 'INACTIVE']) });
interface UserRequest { readonly headers: Record<string, string | string[] | undefined>; identity?: { readonly organizationId: string; readonly userId: string } }

@Controller('users')
export class UsersController {
  constructor(
    private readonly reader: UserManagementReadService,
    private readonly invitations: InvitationCreationService,
    private readonly revocations: InvitationRevocationService,
    private readonly resends: InvitationResendService,
    private readonly memberships: MembershipAdministrationService,
  ) {}

  @Get('management')
  read(@Req() request: UserRequest): Promise<unknown> { return this.reader.read(this.context(request)); }

  @Post('invitations')
  async invite(@Req() request: UserRequest, @Body(new ZodValidationPipe(inviteSchema)) body: z.infer<typeof inviteSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.invitations.create(this.context(request), body, key); }
    catch (error) { this.handleError(error); }
  }

  @Delete('invitations/:id')
  async revokeInvitation(@Req() request: UserRequest, @Param('id', ParseUUIDPipe) id: string) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.revocations.revoke(this.context(request), id, key); }
    catch (error) { this.handleError(error); }
  }

  @Post('invitations/:id/resend')
  async resendInvitation(@Req() request: UserRequest, @Param('id', ParseUUIDPipe) id: string) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.resends.resend(this.context(request), id, key); }
    catch (error) { this.handleError(error); }
  }

  @Patch('memberships/:id/role')
  async changeRole(@Req() request: UserRequest, @Param('id', ParseUUIDPipe) id: string, @IfMatchVersion() expectedVersion: number, @Body(new ZodValidationPipe(roleChangeSchema)) body: z.infer<typeof roleChangeSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.memberships.changeRole(this.context(request), id, { ...body, expectedVersion }, key); }
    catch (error) { this.handleError(error); }
  }

  @Patch('memberships/:id/status')
  async changeStatus(@Req() request: UserRequest, @Param('id', ParseUUIDPipe) id: string, @IfMatchVersion() expectedVersion: number, @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.memberships.setStatus(this.context(request), id, { ...body, expectedVersion }, key); }
    catch (error) { this.handleError(error); }
  }

  @Delete('memberships/:id')
  async revokeMembership(@Req() request: UserRequest, @Param('id', ParseUUIDPipe) id: string, @IfMatchVersion() expectedVersion: number) {
    const key = requireIdempotencyKey(request.headers);
    try { return await this.memberships.revoke(this.context(request), id, expectedVersion, key); }
    catch (error) { this.handleError(error); }
  }

  private context(request: UserRequest): TenantTransactionContext {
    if (!request.identity) throw new UnauthorizedException();
    const requestId = request.headers['x-request-id'];
    return { organizationId: request.identity.organizationId, userId: request.identity.userId, requestId: typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : randomUUID() };
  }

  private handleError(error: unknown): never {
    if (error instanceof IdempotencyKeyReusedError) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', title: 'Clave reutilizada', detail: 'La clave ya se usó con otros datos.' });
    if (error instanceof IdempotencyReplayForbiddenError) throw new ForbiddenException({ code: 'IDEMPOTENCY_REPLAY_FORBIDDEN', title: 'Acceso denegado', detail: 'No podés recuperar esta operación.' });
    if (error instanceof IdempotencyReplayPendingError) throw new ConflictException({ code: 'IDEMPOTENCY_REPLAY_PENDING', title: 'Operación en curso', detail: 'La operación sigue en curso. Intentá nuevamente.' });
    if (error instanceof InvitationCreationPolicyError || error instanceof InvitationRevocationError || error instanceof InvitationResendError || error instanceof MembershipAdministrationError || error instanceof NonOwnerMembershipPolicyError) {
      const body = { code: error.code, title: 'Operación de usuarios rechazada', detail: error.message };
      if (error.code.endsWith('_FORBIDDEN') || error.code === 'MEMBERSHIP_MANAGEMENT_FORBIDDEN') throw new ForbiddenException(body);
      if (error.code.endsWith('_INVALID') || error.code.endsWith('_REQUIRED') || error.code.endsWith('_DUPLICATED')) throw new BadRequestException(body);
      throw new ConflictException(body);
    }
    throw error;
  }
}
