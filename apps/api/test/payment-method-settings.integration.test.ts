import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import {
  PaymentMethodSettingsError,
  PaymentMethodSettingsService,
} from '../src/modules/organizations/payment-method-settings.service.js';

describe('payment method settings', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let service: PaymentMethodSettingsService;
  let organizationA: string;
  let organizationB: string;
  let ownerUserId: string;
  let adminUserId: string;
  let cashierUserId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'uco_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    service = new PaymentMethodSettingsService(new TenantTransaction(runtimePool));
    organizationA = randomUUID();
    organizationB = randomUUID();
    ownerUserId = randomUUID();
    adminUserId = randomUUID();
    cashierUserId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'payment-owner@example.com', '$argon2id$v=19$owner', 1),
       ($2, 'payment-admin@example.com', '$argon2id$v=19$admin', 1),
       ($3, 'payment-cashier@example.com', '$argon2id$v=19$cashier', 1)`,
      [ownerUserId, adminUserId, cashierUserId],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Payments A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Payments B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'),
       ($4, $2, $5, 'ADMIN'),
       ($6, $2, $7, 'CASHIER')`,
      [randomUUID(), organizationA, ownerUserId, randomUUID(), adminUserId, randomUUID(), cashierUserId],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('creates all five organization settings enabled and lets OWNER or ADMIN toggle each one', async () => {
    await expect(service.list(context(ownerUserId, 'payment-list-initial'))).resolves.toEqual([
      { enabled: true, method: 'CASH' },
      { enabled: true, method: 'CREDIT_CARD' },
      { enabled: true, method: 'DEBIT_CARD' },
      { enabled: true, method: 'QR' },
      { enabled: true, method: 'TRANSFER' },
    ]);

    for (const method of ['CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'TRANSFER', 'QR'] as const) {
      await expect(service.setEnabled(context(ownerUserId, `payment-disable-${method}`), method, false))
        .resolves.toEqual({ enabled: false, method });
    }
    await expect(service.setEnabled(context(adminUserId, 'payment-enable-qr'), 'QR', true))
      .resolves.toEqual({ enabled: true, method: 'QR' });

    expect(await service.list(context(ownerUserId, 'payment-list-final'))).toEqual([
      { enabled: false, method: 'CASH' },
      { enabled: false, method: 'CREDIT_CARD' },
      { enabled: false, method: 'DEBIT_CARD' },
      { enabled: true, method: 'QR' },
      { enabled: false, method: 'TRANSFER' },
    ]);
  });

  it('rejects operational roles and has no cross-tenant effect', async () => {
    await expect(service.setEnabled(context(cashierUserId, 'payment-cashier'), 'CASH', true))
      .rejects.toMatchObject({
        code: 'PAYMENT_METHOD_SETTINGS_FORBIDDEN',
      } satisfies Partial<PaymentMethodSettingsError>);

    await expect(service.list({ organizationId: organizationB, requestId: 'payment-other', userId: ownerUserId }))
      .rejects.toMatchObject({
        code: 'PAYMENT_METHOD_SETTINGS_FORBIDDEN',
      } satisfies Partial<PaymentMethodSettingsError>);
  });

  function context(userId: string, requestId: string) {
    return { organizationId: organizationA, requestId, userId };
  }
});
