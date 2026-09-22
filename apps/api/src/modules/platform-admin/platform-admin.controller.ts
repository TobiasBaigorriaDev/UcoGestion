import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Post,
  Param,
  Req,
  UnauthorizedException,
} from '@nestjs/common';

import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { PublicRoute } from '../auth/public-route.decorator.js';
import { readSessionCookie } from '../auth/session-cookie.js';
import { SessionAuthenticationService } from '../auth/session-authentication.service.js';
import {
  PlatformAuthorizationError,
  PlatformProvisioningService,
  PlatformRequestConflictError,
} from './platform-provisioning.service.js';
import {
  OwnerRecoveryNotAllowedError,
  ownerRecoveryRequestSchema,
  type OwnerRecoveryRequest,
  PlatformOwnerRecoveryService,
} from './platform-owner-recovery.service.js';
import {
  provisionOrganizationCommandSchema,
  type ProvisionOrganizationCommand,
} from './provisioning.contract.js';

interface PlatformRequest {
  readonly headers: Record<string, string | string[] | undefined>;
}

@Controller('platform/organizations')
export class PlatformAdminController {
  constructor(
    private readonly sessions: SessionAuthenticationService,
    private readonly provisioning: PlatformProvisioningService,
    private readonly ownerRecovery: PlatformOwnerRecoveryService,
  ) {}

  @Post(':organizationId/recover-owner')
  @PublicRoute()
  async recoverOwner(
    @Req() request: PlatformRequest,
    @Param('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(ownerRecoveryRequestSchema)) input: OwnerRecoveryRequest,
  ) {
    const identity = await this.requireSession(request);
    try {
      return await this.ownerRecovery.execute(identity.userId, { ...input, organizationId });
    } catch (error) {
      if (error instanceof OwnerRecoveryNotAllowedError) {
        throw new ConflictException({ code: error.code, title: 'Recuperación no disponible', detail: error.message });
      }
      this.rethrowPlatformError(error);
    }
  }

  @Post()
  @PublicRoute()
  async provision(
    @Req() request: PlatformRequest,
    @Body(new ZodValidationPipe(provisionOrganizationCommandSchema)) command: ProvisionOrganizationCommand,
  ) {
    const identity = await this.requireSession(request);

    try {
      return await this.provisioning.execute(identity.userId, command);
    } catch (error) {
      this.rethrowPlatformError(error);
    }
  }

  private async requireSession(request: PlatformRequest) {
    const token = readSessionCookie(request.headers.cookie);
    const identity = token ? await this.sessions.authenticate(token) : null;
    if (!identity) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        title: 'Sesión inválida',
        detail: 'Iniciá sesión nuevamente.',
      });
    }
    return identity;
  }

  private rethrowPlatformError(error: unknown): never {
    if (error instanceof PlatformAuthorizationError) {
      throw new ForbiddenException({ code: error.code, title: 'Acceso denegado', detail: error.message });
    }
    if (error instanceof PlatformRequestConflictError) {
      throw new ConflictException({ code: error.code, title: 'Solicitud en conflicto', detail: error.message });
    }
    throw error;
  }
}
