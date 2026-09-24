import type { ServerResponse } from 'node:http';

import {
  Body,
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { InvalidCredentialsError, LoginService } from './login.service.js';
import { PasswordResetRequestService } from './password-reset-request.service.js';
import {
  InvalidPasswordResetTokenError,
  PasswordResetConsumeService,
} from './password-reset-consume.service.js';
import { RateLimitExceededError } from './postgres-rate-limit.service.js';
import { CsrfExempt } from './csrf-exempt.decorator.js';
import { CsrfService } from './csrf.service.js';
import { PublicRoute } from './public-route.decorator.js';
import { readSessionCookie } from './session-cookie.js';
import { SessionRevocationService } from './session-revocation.service.js';
import { ExistingAccountInvitationAcceptanceService, InvitationAcceptanceError } from '../users/existing-account-invitation-acceptance.service.js';
import { NewAccountInvitationAcceptanceService } from '../users/new-account-invitation-acceptance.service.js';
import { randomUUID } from 'node:crypto';

const loginRequestSchema = z.strictObject({
  email: z.string().trim().pipe(z.email()),
  password: z.string().min(1),
});

const forgotPasswordRequestSchema = z.strictObject({
  email: z.string().trim().pipe(z.email()),
});

const resetPasswordRequestSchema = z.strictObject({
  password: z.string().min(12).max(256),
  token: z.string().min(1).max(512),
});
const acceptInvitationSchema = z.strictObject({ token: z.string().min(1).max(512), password: z.string().min(12).max(256).optional() });

type LoginRequest = z.infer<typeof loginRequestSchema>;
type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;
type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly loginService: LoginService,
    private readonly passwordResetRequest: PasswordResetRequestService,
    private readonly passwordResetConsume: PasswordResetConsumeService,
    private readonly sessionRevocation: SessionRevocationService,
    private readonly csrf: CsrfService,
    private readonly existingInvitation: ExistingAccountInvitationAcceptanceService,
    private readonly newInvitation: NewAccountInvitationAcceptanceService,
  ) {}

  @Post('accept-invitation')
  @PublicRoute()
  @CsrfExempt()
  async acceptInvitation(@Body(new ZodValidationPipe(acceptInvitationSchema)) input: z.infer<typeof acceptInvitationSchema>, @Req() request: { readonly headers: Record<string, string | string[] | undefined> }): Promise<{ membershipId: string; organizationId: string }> {
    const requestId = typeof request.headers['x-request-id'] === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(request.headers['x-request-id']) ? request.headers['x-request-id'] : randomUUID();
    try {
      return input.password === undefined
        ? await this.existingInvitation.accept(input.token, requestId)
        : await this.newInvitation.accept({ token: input.token, password: input.password }, requestId);
    } catch (error) {
      if (error instanceof InvitationAcceptanceError) {
        throw new BadRequestException({ code: error.code, title: 'Invitación no disponible', detail: 'La invitación venció, fue revocada o ya se usó. Solicitá otra.' });
      }
      throw error;
    }
  }

  @Post('forgot-password')
  @PublicRoute()
  @CsrfExempt()
  @HttpCode(202)
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordRequestSchema)) input: ForgotPasswordRequest,
    @Ip() ipAddress: string,
  ): Promise<{ accepted: true }> {
    try {
      return await this.passwordResetRequest.execute({ email: input.email, ipAddress });
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        throw new HttpException(
          { code: error.code, title: 'Intento no disponible', detail: error.message },
          HttpStatus.TOO_MANY_REQUESTS,
          { cause: error },
        );
      }
      throw error;
    }
  }

  @Post('reset-password')
  @PublicRoute()
  @CsrfExempt()
  @HttpCode(204)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordRequestSchema)) input: ResetPasswordRequest,
  ): Promise<void> {
    try {
      await this.passwordResetConsume.execute(input);
    } catch (error) {
      if (error instanceof InvalidPasswordResetTokenError) {
        throw new BadRequestException({
          code: error.code,
          title: 'Enlace de recuperación inválido',
          detail: error.message,
        });
      }
      throw error;
    }
  }

  @Post('login')
  @PublicRoute()
  @CsrfExempt()
  @HttpCode(204)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) input: LoginRequest,
    @Ip() ipAddress: string,
    @Res({ passthrough: true }) response: Pick<ServerResponse, 'setHeader'>,
  ): Promise<void> {
    try {
      const result = await this.loginService.execute(input, { ipAddress });
      response.setHeader(
        'Set-Cookie',
        `__Host-uco_session=${result.token}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      );
      response.setHeader('Cache-Control', 'no-store');
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        throw new UnauthorizedException({
          code: error.code,
          title: 'Credenciales inválidas',
          detail: error.message,
        });
      }
      if (error instanceof RateLimitExceededError) {
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
        throw new HttpException(
          { code: error.code, title: 'Intento no disponible', detail: error.message },
          HttpStatus.TOO_MANY_REQUESTS,
          { cause: error },
        );
      }
      throw error;
    }
  }

  @Get('csrf')
  @PublicRoute()
  async getCsrfToken(
    @Req() request: { readonly headers: { readonly cookie?: string | string[] } },
    @Res({ passthrough: true }) response: Pick<ServerResponse, 'setHeader'>,
  ): Promise<{ csrfToken: string }> {
    const sessionToken = readSessionCookie(request.headers.cookie);
    const csrfToken = sessionToken ? await this.csrf.issue(sessionToken) : null;
    if (!csrfToken) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        title: 'Sesión inválida',
        detail: 'Iniciá sesión nuevamente.',
      });
    }
    response.setHeader('Cache-Control', 'no-store');
    return { csrfToken };
  }

  @Post('logout')
  @PublicRoute()
  @HttpCode(204)
  async logout(
    @Req() request: { readonly headers: { readonly cookie?: string | string[] } },
    @Res({ passthrough: true }) response: Pick<ServerResponse, 'setHeader'>,
  ): Promise<void> {
    const token = readSessionCookie(request.headers.cookie);
    if (token) await this.sessionRevocation.revokeToken(token);
    response.setHeader(
      'Set-Cookie',
      '__Host-uco_session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax',
    );
    response.setHeader('Cache-Control', 'no-store');
  }
}
