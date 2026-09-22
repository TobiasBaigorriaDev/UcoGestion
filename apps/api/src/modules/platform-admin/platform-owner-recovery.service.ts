import { createHash } from 'node:crypto';

import type { DatabaseError } from 'pg';
import { z } from 'zod';

import { PlatformDatabase } from './platform-database.js';
import { PlatformAuthorizationError, PlatformRequestConflictError } from './platform-provisioning.service.js';

export const ownerRecoveryCommandSchema = z.strictObject({
  confirmation: z.literal('RECOVER_OWNER'),
  organizationId: z.uuid(),
  ownerEmail: z.string().trim().toLowerCase().pipe(z.email()),
  requestId: z.string().trim().min(1).max(200),
});

export const ownerRecoveryRequestSchema = ownerRecoveryCommandSchema.omit({ organizationId: true });

export type OwnerRecoveryCommand = z.infer<typeof ownerRecoveryCommandSchema>;
export type OwnerRecoveryRequest = z.infer<typeof ownerRecoveryRequestSchema>;

export class OwnerRecoveryNotAllowedError extends Error {
  readonly code = 'OWNER_RECOVERY_NOT_ALLOWED';

  constructor() {
    super('La recuperación excepcional solo está disponible para una organización activa sin OWNER vigente.');
    this.name = 'OwnerRecoveryNotAllowedError';
  }
}

export class PlatformOwnerRecoveryService {
  constructor(private readonly database: PlatformDatabase) {}

  async execute(actorUserId: string, rawCommand: OwnerRecoveryCommand) {
    const command = ownerRecoveryCommandSchema.parse(rawCommand);
    const requestHash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    try {
      return await this.database.withClient(async (client) => {
        const result = await client.query<{ membershipId: string; userId: string }>(
          `SELECT membership_id AS "membershipId", user_id AS "userId"
           FROM platform_api.recover_owner($1, $2, $3, $4, $5)`,
          [actorUserId, command.requestId, requestHash, command.organizationId, command.ownerEmail],
        );
        const row = result.rows[0];
        if (!row) throw new Error('OWNER recovery did not return its persisted result.');
        return row;
      });
    } catch (error) {
      const databaseError = error as Partial<DatabaseError>;
      if (databaseError.code === '42501') throw new PlatformAuthorizationError('Se requiere un administrador de plataforma.');
      if (databaseError.code === '23505') throw new PlatformRequestConflictError('La solicitud ya fue usada con otros datos.');
      if (databaseError.code === 'P0001' && databaseError.message === 'OWNER_RECOVERY_NOT_ALLOWED') {
        throw new OwnerRecoveryNotAllowedError();
      }
      throw error;
    }
  }
}
