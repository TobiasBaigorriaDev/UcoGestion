import { createVerify, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { recordConfigurationExposure } from './configuration-version.service.js';

export type ConfigurationBarrierErrorCode =
  | 'CONFIGURATION_BARRIER_ACTIVE'
  | 'CONFIGURATION_BARRIER_FORBIDDEN'
  | 'CONFIGURATION_BARRIER_INVALID'
  | 'CONFIGURATION_CHECKPOINT_MISSING'
  | 'CONFIGURATION_CHECKPOINT_SIGNATURE_INVALID'
  | 'CONFIGURATION_CHECKPOINT_STALE'
  | 'CONFIGURATION_GRANT_INVALID';

export class ConfigurationBarrierError extends Error {
  constructor(readonly code: ConfigurationBarrierErrorCode, message: string) {
    super(message);
    this.name = 'ConfigurationBarrierError';
  }
}

export interface DeviceCheckpoint {
  readonly grantId: string;
  readonly sequence: number;
  readonly headHash: string;
  readonly signature: string;
}

interface BarrierRow {
  id: string;
  epoch: number;
  status: string;
}

interface GrantRow {
  id: string;
  device_id: string;
  epoch: number;
  public_key: string;
}

export class ConfigurationBarrierService {
  constructor(private readonly transactions: TenantTransaction) {}

  async issueGrant(
    context: TenantTransactionContext,
    deviceId: string,
    configurationVersion: number,
  ): Promise<{ readonly id: string; readonly epoch: number }> {
    const id = randomUUID();
    return this.transactions.run(context, this.audit('offline_grant.issued', id, 'offline_grant'), async (client) => {
      await this.requireManager(client, context);
      const epoch = await this.lockCurrentEpoch(client, context.organizationId);
      const active = await client.query(
        `SELECT 1 FROM configuration_barriers WHERE organization_id = $1 AND status = 'ACTIVE'`,
        [context.organizationId],
      );
      if ((active.rowCount ?? 0) > 0) {
        throw new ConfigurationBarrierError('CONFIGURATION_BARRIER_ACTIVE', 'La barrera de configuración impide emitir grants.');
      }
      const device = await client.query(
        `SELECT 1 FROM devices WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'`,
        [context.organizationId, deviceId],
      );
      const version = await client.query<{ currency: string }>(
        `SELECT snapshot->>'currency' AS currency FROM configuration_versions
         WHERE organization_id = $1 AND version = $2`,
        [context.organizationId, configurationVersion],
      );
      const currentCurrency = await client.query<{ base_currency: string }>(
        'SELECT base_currency FROM organizations WHERE id = $1', [context.organizationId],
      );
      if ((device.rowCount ?? 0) === 0 ||
        version.rows[0]?.currency !== currentCurrency.rows[0]?.base_currency) {
        throw new ConfigurationBarrierError('CONFIGURATION_GRANT_INVALID', 'Dispositivo o versión no autorizados.');
      }
      await client.query(
        `INSERT INTO offline_grants
           (id, organization_id, device_id, epoch, configuration_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '72 hours')`,
        [id, context.organizationId, deviceId, epoch, configurationVersion],
      );
      await recordConfigurationExposure(client, context.organizationId, id);
      return { id, epoch };
    });
  }

  async begin(context: TenantTransactionContext): Promise<{ readonly id: string; readonly epoch: number }> {
    const id = randomUUID();
    return this.transactions.run(context, this.audit('configuration.barrier_started', id, 'configuration_barrier'),
      async (client) => {
        await this.requireManager(client, context);
        const epoch = await this.lockCurrentEpoch(client, context.organizationId);
        const existing = await client.query(
          `SELECT 1 FROM configuration_barriers WHERE organization_id = $1 AND status = 'ACTIVE'`,
          [context.organizationId],
        );
        if ((existing.rowCount ?? 0) > 0) {
          throw new ConfigurationBarrierError('CONFIGURATION_BARRIER_ACTIVE', 'Ya existe una barrera activa.');
        }
        await client.query(
          `INSERT INTO configuration_barriers (id, organization_id, epoch, status)
           VALUES ($1, $2, $3, 'ACTIVE')`,
          [id, context.organizationId, epoch],
        );
        return { id, epoch };
      });
  }

  async submitCheckpoint(
    context: TenantTransactionContext,
    barrierId: string,
    checkpoint: DeviceCheckpoint,
  ): Promise<void> {
    return this.transactions.run(context,
      this.audit('configuration.checkpoint_recorded', barrierId, 'configuration_barrier'),
      async (client) => {
        await this.requireManager(client, context);
        await this.lockCurrentEpoch(client, context.organizationId);
        const barrier = await this.activeBarrier(client, context.organizationId, barrierId);
        const grant = await client.query<GrantRow>(
          `SELECT g.id, g.device_id, g.epoch::integer AS epoch, d.public_key
           FROM offline_grants g JOIN devices d ON d.organization_id = g.organization_id AND d.id = g.device_id
           WHERE g.organization_id = $1 AND g.id = $2 AND g.epoch <= $3 AND g.closed_at IS NULL`,
          [context.organizationId, checkpoint.grantId, barrier.epoch],
        );
        const row = grant.rows[0];
        if (!row) throw new ConfigurationBarrierError('CONFIGURATION_GRANT_INVALID', 'El grant no pertenece a esta barrera.');
        if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0 ||
          !/^[0-9a-f]{64}$/.test(checkpoint.headHash)) {
          throw new ConfigurationBarrierError('CONFIGURATION_CHECKPOINT_STALE', 'La secuencia o hash del checkpoint es inválido.');
        }
        const canonicalPayload = JSON.stringify({
          organizationId: context.organizationId, barrierId, grantId: checkpoint.grantId,
          epoch: barrier.epoch, sequence: checkpoint.sequence,
          headHash: checkpoint.headHash, creationFrozen: true,
        });
        const verifier = createVerify('SHA256');
        verifier.update(canonicalPayload);
        verifier.end();
        if (!verifier.verify(row.public_key, Buffer.from(checkpoint.signature, 'base64'))) {
          throw new ConfigurationBarrierError('CONFIGURATION_CHECKPOINT_SIGNATURE_INVALID',
            'La firma del dispositivo no verifica el checkpoint.');
        }
        await this.requireAckContinuity(client, context.organizationId, row.device_id, row.epoch,
          checkpoint.sequence, checkpoint.headHash);
        await client.query(
          `INSERT INTO configuration_checkpoints
             (id, organization_id, barrier_id, grant_id, device_id, epoch,
              sequence, head_hash, canonical_payload, signature)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [randomUUID(), context.organizationId, barrierId, checkpoint.grantId,
            row.device_id, row.epoch, checkpoint.sequence, checkpoint.headHash,
            canonicalPayload, checkpoint.signature],
        );
      });
  }

  async complete(context: TenantTransactionContext, barrierId: string): Promise<void> {
    return this.transactions.run(context,
      this.audit('configuration.barrier_completed', barrierId, 'configuration_barrier'),
      async (client) => {
        await this.requireManager(client, context);
        await this.lockCurrentEpoch(client, context.organizationId);
        const barrier = await this.activeBarrier(client, context.organizationId, barrierId);
        const grants = await client.query<GrantRow>(
          `SELECT g.id, g.device_id, g.epoch::integer AS epoch, d.public_key
           FROM offline_grants g JOIN devices d ON d.organization_id = g.organization_id AND d.id = g.device_id
           WHERE g.organization_id = $1 AND g.epoch <= $2 AND g.closed_at IS NULL ORDER BY g.id`,
          [context.organizationId, barrier.epoch],
        );
        for (const grant of grants.rows) {
          const checkpoints = await client.query<{ sequence: number; head_hash: string }>(
            `SELECT sequence::integer AS sequence, head_hash FROM configuration_checkpoints
             WHERE organization_id = $1 AND barrier_id = $2 AND grant_id = $3
             ORDER BY sequence DESC, created_at DESC LIMIT 1`,
            [context.organizationId, barrierId, grant.id],
          );
          const checkpoint = checkpoints.rows[0];
          if (!checkpoint) {
            throw new ConfigurationBarrierError('CONFIGURATION_CHECKPOINT_MISSING',
              'Falta el checkpoint de una autorización que pudo crear operaciones.');
          }
          await this.requireAckContinuity(client, context.organizationId, grant.device_id, grant.epoch,
            checkpoint.sequence, checkpoint.head_hash);
        }
        await client.query(
          `UPDATE offline_grants SET closed_at = now()
           WHERE organization_id = $1 AND epoch <= $2 AND closed_at IS NULL`,
          [context.organizationId, barrier.epoch],
        );
        await client.query(
          `UPDATE offline_configuration_exposures SET cleared_at = now()
           WHERE organization_id = $1 AND epoch <= $2 AND cleared_at IS NULL`,
          [context.organizationId, barrier.epoch],
        );
        await client.query(
          `UPDATE configuration_barriers SET status = 'COMPLETED', completed_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [context.organizationId, barrierId],
        );
        await client.query(
          `UPDATE organizations SET config_epoch = config_epoch + 1 WHERE id = $1`,
          [context.organizationId],
        );
      });
  }

  private async requireAckContinuity(client: PoolClient, organizationId: string, deviceId: string,
    epoch: number, sequence: number, headHash: string): Promise<void> {
    const operations = await client.query<{
      sequence: number; prev_hash: string; operation_hash: string; status: string;
    }>(
      `SELECT sequence::integer AS sequence, prev_hash, operation_hash, status
       FROM sync_operations WHERE organization_id = $1 AND device_id = $2 AND epoch = $3
       ORDER BY sequence`,
      [organizationId, deviceId, epoch],
    );
    if (operations.rows.length !== sequence) {
      throw new ConfigurationBarrierError('CONFIGURATION_CHECKPOINT_STALE',
        'El checkpoint no cubre todas las operaciones del dispositivo.');
    }
    let previous = '0'.repeat(64);
    for (const [index, operation] of operations.rows.entries()) {
      if (operation.sequence !== index + 1 || operation.prev_hash !== previous || operation.status !== 'ACKED') {
        throw new ConfigurationBarrierError('CONFIGURATION_CHECKPOINT_STALE',
          'La cadena de operaciones o sus ACKs no son continuos y definitivos.');
      }
      previous = operation.operation_hash;
    }
    if (previous !== headHash) {
      throw new ConfigurationBarrierError('CONFIGURATION_CHECKPOINT_STALE',
        'El hash del checkpoint no coincide con la cadena confirmada.');
    }
  }

  private async activeBarrier(client: PoolClient, organizationId: string, barrierId: string): Promise<BarrierRow> {
    const result = await client.query<BarrierRow>(
      `SELECT id, epoch::integer AS epoch, status FROM configuration_barriers
       WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'`,
      [organizationId, barrierId],
    );
    const barrier = result.rows[0];
    if (!barrier) throw new ConfigurationBarrierError('CONFIGURATION_BARRIER_INVALID', 'La barrera no está activa.');
    return barrier;
  }

  private async lockCurrentEpoch(client: PoolClient, organizationId: string): Promise<number> {
    const result = await client.query<{ config_epoch: number }>(
      'SELECT config_epoch::integer AS config_epoch FROM organizations WHERE id = $1 FOR UPDATE',
      [organizationId],
    );
    const epoch = result.rows[0]?.config_epoch;
    if (!epoch) throw new ConfigurationBarrierError('CONFIGURATION_BARRIER_FORBIDDEN', 'La organización no está disponible.');
    return epoch;
  }

  private async requireManager(client: PoolClient, context: TenantTransactionContext): Promise<void> {
    const result = await client.query<{ role: string }>(
      `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2
       AND status = 'ACTIVE' AND revoked_at IS NULL`,
      [context.organizationId, context.userId],
    );
    if (!['OWNER', 'ADMIN'].includes(result.rows[0]?.role ?? '')) {
      throw new ConfigurationBarrierError('CONFIGURATION_BARRIER_FORBIDDEN',
        'Solo OWNER o ADMIN pueden coordinar la barrera de configuración.');
    }
  }

  private audit(action: string, entityId: string, entityType: string) {
    return {
      action, after: {}, afterAllowlist: [], before: {}, beforeAllowlist: [],
      branchId: null, context: {}, contextAllowlist: [], entityId, entityType,
      operationId: randomUUID(),
    };
  }
}
