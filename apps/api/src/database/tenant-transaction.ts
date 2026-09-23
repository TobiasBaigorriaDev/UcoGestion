import type { Pool, PoolClient } from 'pg';

import { AuditEventWriter, type AuditEventInput } from '../core/audit/audit-event-writer.js';

export interface TenantTransactionContext {
  readonly organizationId: string;
  readonly requestId: string;
  readonly userId: string;
}

export type TenantAuditEvent = Omit<AuditEventInput, 'actorUserId' | 'organizationId' | 'requestId'>;

export class TenantTransaction {
  constructor(private readonly pool: Pool) {}

  async run<TResult>(
    context: TenantTransactionContext,
    auditEvent: TenantAuditEvent,
    operation: (client: PoolClient) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [context.organizationId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId]);
      await client.query("SELECT set_config('app.request_id', $1, true)", [context.requestId]);

      const result = await operation(client);
      await new AuditEventWriter(client).append({
        ...auditEvent,
        actorUserId: context.userId,
        organizationId: context.organizationId,
        requestId: context.requestId,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async read<TResult>(
    context: TenantTransactionContext,
    operation: (client: PoolClient) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [context.organizationId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId]);
      await client.query("SELECT set_config('app.request_id', $1, true)", [context.requestId]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async runWithOptionalAudit<TResult>(
    context: TenantTransactionContext,
    operation: (client: PoolClient) => Promise<{
      readonly result: TResult;
      readonly auditEvent?: TenantAuditEvent;
    }>,
  ): Promise<TResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [context.organizationId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId]);
      await client.query("SELECT set_config('app.request_id', $1, true)", [context.requestId]);
      const { result, auditEvent } = await operation(client);
      if (auditEvent) {
        await new AuditEventWriter(client).append({
          ...auditEvent,
          actorUserId: context.userId,
          organizationId: context.organizationId,
          requestId: context.requestId,
        });
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
