import { randomUUID } from 'node:crypto';

import { Body, ConflictException, Controller, ForbiddenException, Header, Post, Req,
  ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { offlineGrantProofSchema } from '@uconext/shared';
import { z } from 'zod';

import { IdempotencyKeyReusedError, IdempotencyReplayForbiddenError } from '../../core/idempotency/idempotency.service.js';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { TenantTransaction } from '../../database/tenant-transaction.js';
import { OfflineBootstrapError, OfflineBootstrapService } from './offline-bootstrap.service.js';
import { loadOfflineKeys, OfflineKeysUnavailableError } from './offline-key-custody.js';
import { OfflineGrantError, OfflineGrantService } from './offline-grant.service.js';

const schema = z.strictObject({ deviceId: z.uuid(), branchId: z.uuid() });
interface RequestContext {
  readonly headers: Record<string, string | string[] | undefined>;
  identity?: { readonly organizationId: string; readonly userId: string };
}

@Controller('offline')
export class OfflineBootstrapController {
  constructor(private readonly transactions: TenantTransaction) {}

  @Post('authorize')
  @Header('Cache-Control', 'no-store')
  async authorize(@Req() request: RequestContext,
    @Body(new ZodValidationPipe(offlineGrantProofSchema)) input: z.infer<typeof offlineGrantProofSchema>) {
    if (!request.identity) throw new UnauthorizedException();
    const key = requireIdempotencyKey(request.headers);
    const requestId = request.headers['x-request-id'];
    try {
      const custody = loadOfflineKeys();
      return await new OfflineGrantService(this.transactions, custody.signingKey, custody.signer.keyId).issue({
        ...request.identity, requestId: typeof requestId === 'string' ? requestId : randomUUID(),
      }, input, key);
    } catch (error) { return translateError(error); }
  }

  @Post('bootstrap')
  @Header('Cache-Control', 'no-store')
  async issue(@Req() request: RequestContext, @Body(new ZodValidationPipe(schema)) input: z.infer<typeof schema>) {
    if (!request.identity) throw new UnauthorizedException();
    const key = requireIdempotencyKey(request.headers);
    const requestId = request.headers['x-request-id'];
    try {
      const custody = loadOfflineKeys();
      return await new OfflineBootstrapService(this.transactions, custody.signer, custody.ingestion).issue({
        ...request.identity, requestId: typeof requestId === 'string' ? requestId : randomUUID(),
      }, input, key);
    } catch (error) { return translateError(error); }
  }
}

function translateError(error: unknown): never {
      if (error instanceof OfflineKeysUnavailableError) throw new ServiceUnavailableException({
        code: 'OFFLINE_KEYS_UNAVAILABLE', title: 'Offline no disponible', detail: 'No se pudo acceder a la custodia de claves.' });
      if (error instanceof OfflineBootstrapError) {
        const problem = { code: error.code, title: 'Preparación offline rechazada', detail: error.message };
        if (error.code === 'OFFLINE_BOOTSTRAP_FORBIDDEN') throw new ForbiddenException(problem);
        throw new ConflictException(problem);
      }
      if (error instanceof OfflineGrantError) {
        const problem = { code: error.code, title: 'Autorización offline rechazada', detail: error.message };
        if (error.code === 'OFFLINE_GRANT_FORBIDDEN') throw new ForbiddenException(problem);
        throw new ConflictException(problem);
      }
      if (error instanceof IdempotencyReplayForbiddenError) throw new ForbiddenException({
        code: 'IDEMPOTENCY_REPLAY_FORBIDDEN', title: 'Acceso denegado', detail: 'No podés recuperar esta operación.' });
      if (error instanceof IdempotencyKeyReusedError) throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED', title: 'Clave reutilizada', detail: 'La clave ya se usó con otros datos.' });
      throw error;
}
