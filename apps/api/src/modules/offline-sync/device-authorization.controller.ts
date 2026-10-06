import { randomUUID } from 'node:crypto';

import { BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError } from '../../core/idempotency/idempotency.service.js';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { DeviceAuthorizationError, DeviceAuthorizationService } from '../cash/device-authorization.service.js';
import { DeviceCertificate } from './device-certificate.js';

const schema = z.strictObject({ branchId: z.uuid(), publicKey: z.string().min(100).max(2000) });
interface RequestContext {
  readonly headers: Record<string, string | string[] | undefined>;
  identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('devices')
export class DeviceAuthorizationController {
  constructor(private readonly devices: DeviceAuthorizationService) {}

  @Post('authorize-pos')
  async authorize(@Req() request: RequestContext, @Body(new ZodValidationPipe(schema)) body: z.infer<typeof schema>) {
    if (!request.identity) throw new UnauthorizedException();
    const key = requireIdempotencyKey(request.headers);
    const secret = process.env.DEVICE_CERTIFICATE_KEY;
    if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      throw new ServiceUnavailableException({ code: 'DEVICE_CERTIFICATE_KEY_UNAVAILABLE',
        title: 'Autorización no disponible', detail: 'No se configuró la clave de certificados.' });
    }
    const certificate = new DeviceCertificate(Buffer.from(secret, 'base64url'));
    const requestId = request.headers['x-request-id'];
    try {
      return await this.devices.authorizePos({ organizationId: request.identity.organizationId,
        userId: request.identity.userId, requestId: typeof requestId === 'string' ? requestId : randomUUID() },
      body.branchId, body.publicKey, key, certificate);
    } catch (error) {
      if (error instanceof DeviceAuthorizationError) {
        const details = { code: error.code, title: 'Autorización rechazada', detail: error.message };
        if (error.code.endsWith('_FORBIDDEN')) throw new ForbiddenException(details);
        throw new ConflictException(details);
      }
      if (error instanceof IdempotencyKeyReusedError) throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED', title: 'Clave reutilizada', detail: 'La clave ya se usó con otros datos.' });
      if (error instanceof IdempotencyReplayForbiddenError) throw new ForbiddenException({
        code: 'IDEMPOTENCY_REPLAY_FORBIDDEN', title: 'Acceso denegado', detail: 'No podés recuperar esta operación.' });
      if (error instanceof Error && /Device public key|Invalid key/.test(error.message)) throw new BadRequestException({
        code: 'DEVICE_PUBLIC_KEY_INVALID', title: 'Clave inválida', detail: 'Se requiere una clave ECDSA P-256.' });
      throw error;
    }
  }
}
