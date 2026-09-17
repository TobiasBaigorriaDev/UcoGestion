import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CSRF_EXEMPT_METADATA } from './csrf-exempt.decorator.js';
import { CsrfService } from './csrf.service.js';
import { readSessionCookie } from './session-cookie.js';

interface IntegrityRequest {
  readonly method: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class RequestIntegrityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly csrf: CsrfService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IntegrityRequest>();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) return true;

    const expectedOrigin = new URL(process.env.UCONEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:3000').origin;
    if (request.headers.origin !== expectedOrigin) {
      throw new ForbiddenException({
        code: 'ORIGIN_INVALID',
        title: 'Origen no autorizado',
        detail: 'La solicitud debe provenir del origen configurado.',
      });
    }
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin') {
      throw new ForbiddenException({
        code: 'FETCH_SITE_INVALID',
        title: 'Origen no autorizado',
        detail: 'La solicitud debe ser del mismo origen.',
      });
    }
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string'
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
      throw new UnsupportedMediaTypeException({
        code: 'JSON_REQUIRED',
        title: 'Tipo de contenido no admitido',
        detail: 'Las mutaciones requieren application/json.',
      });
    }

    if (this.reflector.getAllAndOverride<boolean>(CSRF_EXEMPT_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]) === true) return true;

    const sessionToken = readSessionCookie(request.headers.cookie);
    const csrfToken = request.headers['x-csrf-token'];
    if (!sessionToken || typeof csrfToken !== 'string'
      || !(await this.csrf.verify(sessionToken, csrfToken))) {
      throw new ForbiddenException({
        code: 'CSRF_INVALID',
        title: 'Token CSRF inválido',
        detail: 'Actualizá la página y volvé a intentar.',
      });
    }
    return true;
  }
}
