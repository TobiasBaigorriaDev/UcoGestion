import type { ServerResponse } from 'node:http';

import {
  Body,
  Controller,
  HttpCode,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { InvalidCredentialsError, LoginService } from './login.service.js';
import { PublicRoute } from './public-route.decorator.js';

const loginRequestSchema = z.strictObject({
  email: z.string().trim().pipe(z.email()),
  password: z.string().min(1),
});

type LoginRequest = z.infer<typeof loginRequestSchema>;

@Controller('auth')
export class AuthController {
  constructor(private readonly loginService: LoginService) {}

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
}
