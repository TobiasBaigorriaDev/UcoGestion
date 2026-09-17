import type { ServerResponse } from 'node:http';

import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { InvalidCredentialsError, LoginService } from './login.service.js';
import { PublicRoute } from './public-route.decorator.js';
import { readSessionCookie } from './session-cookie.js';
import { SessionRevocationService } from './session-revocation.service.js';

const loginRequestSchema = z.strictObject({
  email: z.string().trim().pipe(z.email()),
  password: z.string().min(1),
});

type LoginRequest = z.infer<typeof loginRequestSchema>;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly loginService: LoginService,
    private readonly sessionRevocation: SessionRevocationService,
  ) {}

  @Post('login')
  @PublicRoute()
  @HttpCode(204)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) input: LoginRequest,
    @Res({ passthrough: true }) response: Pick<ServerResponse, 'setHeader'>,
  ): Promise<void> {
    try {
      const result = await this.loginService.execute(input);
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
      throw error;
    }
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
