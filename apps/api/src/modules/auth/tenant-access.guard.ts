import { randomUUID } from 'node:crypto';

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PUBLIC_ROUTE_METADATA } from './public-route.decorator.js';
import { SessionAuthenticationService } from './session-authentication.service.js';
import { TenantMembershipService } from './tenant-membership.service.js';

interface ProtectedRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  identity?: { readonly organizationId: string; readonly userId: string };
}

@Injectable()
export class TenantAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionAuthenticationService,
    private readonly memberships: TenantMembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]) === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<ProtectedRequest>();
    const token = readSessionCookie(request.headers.cookie);
    const identity = token ? await this.sessions.authenticate(token) : null;
    if (!identity) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        title: 'Sesión inválida',
        detail: 'Iniciá sesión nuevamente.',
      });
    }

    const organizationId = request.headers['x-organization-id'];
    if (typeof organizationId !== 'string' || !isUuid(organizationId)) {
      throw new ForbiddenException({
        code: 'ORGANIZATION_CONTEXT_REQUIRED',
        title: 'Organización no autorizada',
        detail: 'Seleccioná una organización vigente.',
      });
    }

    const requestId = readRequestId(request.headers['x-request-id']);
    if (!(await this.memberships.isActive(organizationId, identity.userId, requestId))) {
      throw new ForbiddenException({
        code: 'MEMBERSHIP_INACTIVE',
        title: 'Organización no autorizada',
        detail: 'No tenés acceso a esta organización.',
      });
    }
    request.identity = { organizationId, userId: identity.userId };
    return true;
  }
}

function readSessionCookie(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const matches = raw.split(';').map((part) => part.trim())
    .filter((part) => part.startsWith('__Host-uco_session='));
  if (matches.length !== 1) return null;
  const token = matches[0]?.slice('__Host-uco_session='.length);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function readRequestId(value: string | string[] | undefined): string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : randomUUID();
}
