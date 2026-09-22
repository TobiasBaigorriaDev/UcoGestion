import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export const paymentMethods = ['CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'TRANSFER', 'QR'] as const;
export type PaymentMethod = typeof paymentMethods[number];

export interface PaymentMethodSetting {
  readonly enabled: boolean;
  readonly method: PaymentMethod;
}

export type PaymentMethodSettingsErrorCode = 'PAYMENT_METHOD_SETTINGS_FORBIDDEN';

export class PaymentMethodSettingsError extends Error {
  constructor(
    readonly code: PaymentMethodSettingsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentMethodSettingsError';
  }
}

export class PaymentMethodSettingsService {
  constructor(private readonly transactions: TenantTransaction) {}

  async list(context: TenantTransactionContext): Promise<readonly PaymentMethodSetting[]> {
    return this.transactions.read(context, async (client) => {
      await this.requireOwnerOrAdmin(client, context);
      const result = await client.query<PaymentMethodSetting>(
        `SELECT method, enabled
         FROM payment_method_settings
         WHERE organization_id = $1
         ORDER BY method`,
        [context.organizationId],
      );
      return result.rows.map((row) => ({
        enabled: row.enabled,
        method: row.method as PaymentMethod,
      }));
    });
  }

  async setEnabled(
    context: TenantTransactionContext,
    method: PaymentMethod,
    enabled: boolean,
  ): Promise<PaymentMethodSetting> {
    return this.transactions.run(
      context,
      {
        action: 'payment_method_setting.updated',
        after: { enabled, method },
        afterAllowlist: ['enabled', 'method'],
        before: {},
        beforeAllowlist: [],
        branchId: null,
        context: {},
        contextAllowlist: [],
        entityId: context.organizationId,
        entityType: 'payment_method_setting',
        operationId: `${context.requestId}:${method}`,
      },
      async (client) => {
        await this.requireOwnerOrAdmin(client, context);
        const result = await client.query<PaymentMethodSetting>(
          `UPDATE payment_method_settings
           SET enabled = $1, version = version + 1
           WHERE organization_id = $2 AND method = $3
           RETURNING method, enabled`,
          [enabled, context.organizationId, method],
        );
        const row = result.rows.at(0);
        if (!row) throw new Error('La configuración del medio de pago no fue persistida.');
        return { enabled: row.enabled, method: row.method as PaymentMethod };
      },
    );
  }

  private async requireOwnerOrAdmin(
    client: PoolClient,
    context: TenantTransactionContext,
  ): Promise<void> {
    const membership = await client.query<{ role: string }>(
      `SELECT role FROM memberships
       WHERE organization_id = $1 AND user_id = $2
         AND status = 'ACTIVE' AND revoked_at IS NULL`,
      [context.organizationId, context.userId],
    );
    if (!['OWNER', 'ADMIN'].includes(membership.rows.at(0)?.role ?? '')) {
      throw new PaymentMethodSettingsError(
        'PAYMENT_METHOD_SETTINGS_FORBIDDEN',
        'Solo OWNER o ADMIN pueden configurar medios de pago.',
      );
    }
  }
}
