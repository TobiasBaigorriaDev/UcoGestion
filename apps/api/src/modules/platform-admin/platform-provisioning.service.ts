import { createHash } from 'node:crypto';

import type { DatabaseError } from 'pg';

import { hashPassword } from '../auth/password.js';
import { PlatformDatabase } from './platform-database.js';
import {
  provisionOrganizationCommandSchema,
  type ProvisionOrganizationCommand,
} from './provisioning.contract.js';

export interface PlatformProvisioningResult {
  readonly branchId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly userId: string;
}

interface ProvisioningRow {
  branchId: string;
  membershipId: string;
  organizationId: string;
  userId: string;
}

export class PlatformAuthorizationError extends Error {
  readonly code = 'PLATFORM_ADMIN_REQUIRED';
}

export class PlatformRequestConflictError extends Error {
  readonly code = 'PLATFORM_REQUEST_CONFLICT';
}

export class PlatformProvisioningService {
  constructor(private readonly database: PlatformDatabase) {}

  async execute(actorUserId: string, rawCommand: ProvisionOrganizationCommand): Promise<PlatformProvisioningResult> {
    const command = provisionOrganizationCommandSchema.parse(rawCommand);
    const requestHash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const password = await hashPassword(command.ownerPassword);

    try {
      return await this.database.withClient(async (client) => {
        const result = await client.query<ProvisioningRow>(
          `SELECT
            organization_id AS "organizationId",
            branch_id AS "branchId",
            user_id AS "userId",
            membership_id AS "membershipId"
          FROM platform_api.provision_organization($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            actorUserId,
            command.requestId,
            requestHash,
            command.organizationName,
            command.timezone,
            command.ownerEmail,
            password.hash,
            password.version,
            command.firstBranchName,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error('Provisioning did not return its persisted result.');
        return row;
      });
    } catch (error) {
      const code = (error as Partial<DatabaseError>).code;
      if (code === '42501') throw new PlatformAuthorizationError('Se requiere un administrador de plataforma.');
      if (code === '23505') throw new PlatformRequestConflictError('La solicitud ya fue usada con otros datos.');
      throw error;
    }
  }
}
