import { randomUUID } from 'node:crypto';

import { Body, ConflictException, Controller, ForbiddenException, Get, HttpException, HttpStatus, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';

import { PublicRoute } from '../auth/public-route.decorator.js';
import { readSessionCookie } from '../auth/session-cookie.js';
import { SessionAuthenticationService } from '../auth/session-authentication.service.js';
import { OrganizationSettingsService } from './organization-settings.service.js';
import {
  GlobalMembershipDiscoveryService,
  OrganizationNotAvailableError,
} from './global-membership-discovery.service.js';
import { IfMatchVersion, VersionConflictException } from '../../core/validation/if-match.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import {
  OrganizationCurrencyChangeError,
  OrganizationCurrencyChangeService,
} from './organization-currency-change.service.js';
import { organizationCurrencyChangeSchema } from './organization-currency-change.policy.js';
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
    private readonly currencies: OrganizationCurrencyChangeService,
    private readonly settings: OrganizationSettingsService,
  ) {}

  @Get('settings')
  async getSettings(@Req() request: OrganizationRequest) {
    const identity = request.identity;
    if (!identity) throw new UnauthorizedException();
    return this.settings.read({
      organizationId: identity.organizationId,
      userId: identity.userId,
      requestId: this.requestId(request),
    });
  }

  @Patch('currency')
  async updateCurrency(
    @Req() request: OrganizationRequest,
    @IfMatchVersion() expectedVersion: number,
    @Body(new ZodValidationPipe(organizationCurrencyChangeSchema)) update: { targetCurrency: string },
  ) {
    const identity = request.identity;
    if (!identity) throw new UnauthorizedException();
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) {
      throw new HttpException({
        code: 'IDEMPOTENCY_KEY_REQUIRED', title: 'Precondición requerida',
        detail: 'Enviá una clave Idempotency-Key válida.',
      }, HttpStatus.PRECONDITION_REQUIRED);
    }
    try {
      return await this.currencies.change({
        organizationId: identity.organizationId,
        requestId: this.requestId(request),
        userId: identity.userId,
      }, expectedVersion, update.targetCurrency, key);
    } catch (error) {
      if (error instanceof OrganizationCurrencyChangeError) {
        if (error.code === 'CURRENCY_CHANGE_FORBIDDEN') {
          throw new ForbiddenException({ code: error.code, title: 'Acceso denegado', detail: error.message });
        }
        throw new ConflictException({
          code: error.code, title: 'Cambio de moneda bloqueado', detail: error.message,
          ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
        });
      }
      throw error;
    }
  }

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
