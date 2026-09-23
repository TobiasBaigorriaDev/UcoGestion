import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  IdempotencyKeyReusedError,
  IdempotencyReplayForbiddenError,
  IdempotencyService,
} from '../../core/idempotency/idempotency.service.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { ResourceSafetyService } from '../offline-sync/resource-safety.service.js';
import {
  OrganizationCurrencyChangePolicy,
  OrganizationCurrencyChangeDeniedError,
  organizationCurrencyChangeSchema,
} from './organization-currency-change.policy.js';

export type OrganizationCurrencyChangeErrorCode =
  | 'CURRENCY_CHANGE_FORBIDDEN'
  | 'CURRENCY_LOCKED_BY_HISTORY'
  | 'CURRENCY_LOCKED_BY_OFFLINE_UNCERTAINTY'
  | 'CURRENCY_PERMANENTLY_LOCKED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'VERSION_CONFLICT';

export class OrganizationCurrencyChangeError extends Error {
  constructor(
    readonly code: OrganizationCurrencyChangeErrorCode,
    message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = 'OrganizationCurrencyChangeError';
  }
}

export interface OrganizationCurrencyChangeResult {
  readonly currency: string;
  readonly version: number;
}

export class OrganizationCurrencyChangeService {
  private readonly policy = new OrganizationCurrencyChangePolicy();
  private readonly safety: ResourceSafetyService;

  constructor(private readonly transactions: TenantTransaction) {
    this.safety = new ResourceSafetyService(transactions);
  }

  async change(
    context: TenantTransactionContext,
    expectedVersion: number,
    rawTargetCurrency: string,
    idempotencyKey: string,
  ): Promise<OrganizationCurrencyChangeResult> {
    const { targetCurrency } = organizationCurrencyChangeSchema.parse({ targetCurrency: rawTargetCurrency });
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
      !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
      throw new OrganizationCurrencyChangeError('VERSION_CONFLICT', 'La versión o clave idempotente es inválida.');
    }
    try {
      return await this.transactions.runWithOptionalAudit(context, async (client) => {
        await this.requireOwner(client, context);
        const idempotency = new IdempotencyService(client);
        const acquired = await idempotency.acquire({
          actorUserId: context.userId,
          authorizationClass: 'OWNER',
          branchId: null,
          key: idempotencyKey,
          organizationId: context.organizationId,
          payload: { expectedVersion, targetCurrency },
          scope: 'organizations.currency',
        }, async () => {
          await this.requireOwner(client, context);
        });
        if (acquired.kind === 'replay') {
          return { result: this.readStoredResult(acquired.response.body) };
        }

        const org = await client.query<{ base_currency: string; version: number }>(
          `SELECT base_currency, version::integer AS version
           FROM organizations WHERE id = $1 FOR UPDATE`,
          [context.organizationId],
        );
        const current = org.rows[0];
        if (!current) {
          throw new OrganizationCurrencyChangeError('CURRENCY_CHANGE_FORBIDDEN', 'La organización no está disponible.');
        }
        await this.requireOwner(client, context);
        if (current.version !== expectedVersion) {
          throw new OrganizationCurrencyChangeError('VERSION_CONFLICT',
            'La organización fue modificada por otra operación.', current.version);
        }
        const barrier = await client.query(
          `SELECT 1 FROM configuration_barriers WHERE organization_id = $1 AND status = 'ACTIVE'`,
          [context.organizationId],
        );
        if ((barrier.rowCount ?? 0) > 0) {
          throw new OrganizationCurrencyChangeError('CURRENCY_LOCKED_BY_OFFLINE_UNCERTAINTY',
            'Hay una barrera de configuración en curso.');
        }
        const safety = await this.safety.currencyInTransaction(client, context.organizationId);
        if (safety === 'PERMANENT') {
          throw new OrganizationCurrencyChangeError('CURRENCY_PERMANENTLY_LOCKED',
            'La moneda quedó bloqueada por un dispositivo irrecuperable.');
        }
        if (safety === 'HISTORY') {
          this.policy.authorize({ actorRole: 'OWNER', hasServerHistory: true, targetCurrency });
        }
        if (safety === 'UNCERTAIN') {
          throw new OrganizationCurrencyChangeError('CURRENCY_LOCKED_BY_OFFLINE_UNCERTAINTY',
            'Puede haber operaciones offline pendientes bajo la moneda actual.');
        }
        const result = current.base_currency === targetCurrency
          ? { currency: targetCurrency, version: current.version }
          : await this.persistChange(client, context.organizationId, targetCurrency);
        await idempotency.complete(acquired.record.id, {
          statusCode: 200, body: { currency: result.currency, version: result.version },
        });
        if (current.base_currency === targetCurrency) return { result };
        return {
          result,
          auditEvent: {
            action: 'organization.currency_changed',
            after: { currency: targetCurrency }, afterAllowlist: ['currency'],
            before: { currency: current.base_currency }, beforeAllowlist: ['currency'],
            branchId: null, context: { version: result.version }, contextAllowlist: ['version'],
            entityId: context.organizationId, entityType: 'organization', operationId: randomUUID(),
          },
        };
      });
    } catch (error) {
      if (error instanceof OrganizationCurrencyChangeDeniedError) {
        throw new OrganizationCurrencyChangeError(error.code, error.message);
      }
      if (error instanceof IdempotencyKeyReusedError) {
        throw new OrganizationCurrencyChangeError('IDEMPOTENCY_KEY_REUSED', error.message);
      }
      if (error instanceof IdempotencyReplayForbiddenError) {
        throw new OrganizationCurrencyChangeError('CURRENCY_CHANGE_FORBIDDEN', error.message);
      }
      throw error;
    }
  }

  private async persistChange(
    client: PoolClient,
    organizationId: string,
    targetCurrency: string,
  ): Promise<OrganizationCurrencyChangeResult> {
    const updated = await client.query<{ currency: string; version: number }>(
      `UPDATE organizations SET base_currency = $1, version = version + 1
       WHERE id = $2 RETURNING base_currency AS currency, version::integer AS version`,
      [targetCurrency, organizationId],
    );
    const result = updated.rows[0];
    if (!result) throw new Error('La moneda base no fue persistida.');
    return result;
  }

  private async requireOwner(client: PoolClient, context: TenantTransactionContext): Promise<void> {
    const membership = await client.query<{ role: string }>(
      `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2
       AND status = 'ACTIVE' AND revoked_at IS NULL`,
      [context.organizationId, context.userId],
    );
    if (membership.rows[0]?.role !== 'OWNER') {
      throw new OrganizationCurrencyChangeError('CURRENCY_CHANGE_FORBIDDEN', 'Solo OWNER puede cambiar la moneda base.');
    }
  }

  private readStoredResult(body: unknown): OrganizationCurrencyChangeResult {
    if (typeof body === 'object' && body !== null && !Array.isArray(body) &&
      'currency' in body && typeof body.currency === 'string' &&
      'version' in body && typeof body.version === 'number') {
      return { currency: body.currency, version: body.version };
    }
    throw new Error('La respuesta idempotente de moneda no es válida.');
  }
}
