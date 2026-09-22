import { randomUUID } from 'node:crypto';

import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';

import { PublicRoute } from '../auth/public-route.decorator.js';
import { readSessionCookie } from '../auth/session-cookie.js';
import { SessionAuthenticationService } from '../auth/session-authentication.service.js';
import {
  GlobalMembershipDiscoveryService,
  OrganizationNotAvailableError,
} from './global-membership-discovery.service.js';
import { IfMatchVersion, VersionConflictException } from '../../core/validation/if-match.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import {
  OrganizationProfilePermissionError,
  OrganizationProfileService,
  OrganizationProfileVersionError,
  organizationProfileUpdateSchema,
  type OrganizationProfileUpdate,
} from './organization-profile.service.js';
import {
  OrganizationTimezonePermissionError,
  OrganizationTimezoneService,
  OrganizationTimezoneVersionError,
  organizationTimezoneUpdateSchema,
  type OrganizationTimezoneUpdate,
} from './organization-timezone.service.js';

interface OrganizationRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly sessions: SessionAuthenticationService,
    private readonly discovery: GlobalMembershipDiscoveryService,
    private readonly profiles: OrganizationProfileService,
    private readonly timezones: OrganizationTimezoneService,
  ) {}

  @Patch('timezone')
  async updateTimezone(
    @Req() request: OrganizationRequest,
    @IfMatchVersion() expectedVersion: number,
    @Body(new ZodValidationPipe(organizationTimezoneUpdateSchema)) update: OrganizationTimezoneUpdate,
  ) {
    const identity = request.identity;
    if (!identity) throw new UnauthorizedException();
    try {
      return await this.timezones.update(
        {
          organizationId: identity.organizationId,
          requestId: this.requestId(request),
          userId: identity.userId,
        },
        expectedVersion,
        update,
      );
    } catch (error) {
      if (error instanceof OrganizationTimezonePermissionError) {
        throw new ForbiddenException({ code: error.code, title: 'Acceso denegado', detail: error.message });
      }
      if (error instanceof OrganizationTimezoneVersionError) {
        throw new VersionConflictException({ currentVersion: error.currentVersion });
      }
      throw error;
    }
  }

  @Patch('profile')
  async updateProfile(
    @Req() request: OrganizationRequest,
    @IfMatchVersion() expectedVersion: number,
    @Body(new ZodValidationPipe(organizationProfileUpdateSchema)) profile: OrganizationProfileUpdate,
  ) {
    const identity = request.identity;
    if (!identity) throw new UnauthorizedException();
    try {
      return await this.profiles.update(
        {
          organizationId: identity.organizationId,
          requestId: this.requestId(request),
          userId: identity.userId,
        },
        expectedVersion,
        profile,
      );
    } catch (error) {
      if (error instanceof OrganizationProfilePermissionError) {
        throw new ForbiddenException({ code: error.code, title: 'Acceso denegado', detail: error.message });
      }
      if (error instanceof OrganizationProfileVersionError) {
        throw new VersionConflictException({ currentVersion: error.currentVersion });
      }
      throw error;
    }
  }

  @Get()
  @PublicRoute()
  async list(@Req() request: OrganizationRequest) {
    const userId = await this.requireUser(request);
    return { organizations: await this.discovery.list(userId) };
  }

  @Post(':organizationId/select')
  @PublicRoute()
  async select(@Req() request: OrganizationRequest, @Param('organizationId') organizationId: string) {
    const userId = await this.requireUser(request);
    try {
      return await this.discovery.select(userId, organizationId);
    } catch (error) {
      if (error instanceof OrganizationNotAvailableError) {
        throw new ForbiddenException({
          code: error.code,
          title: 'Organización no disponible',
          detail: error.message,
        });
      }
      throw error;
    }
  }

  private async requireUser(request: OrganizationRequest): Promise<string> {
    const token = readSessionCookie(request.headers.cookie);
    const identity = token ? await this.sessions.authenticate(token) : null;
    if (!identity) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        title: 'Sesión inválida',
        detail: 'Iniciá sesión nuevamente.',
      });
    }
    return identity.userId;
  }

  private requestId(request: OrganizationRequest): string {
    const value = request.headers['x-request-id'];
    return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
      ? value
      : randomUUID();
  }
}
