import { createVerify, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface ConfigurationSigner {
  readonly keyId: string;
  readonly publicKeyPem: string;
  sign(payload: string): string;
}

interface ConfiguredResource {
  readonly id: string;
}

export interface ConfigurationSnapshot {
  readonly currency: string;
  readonly items: readonly (ConfiguredResource & {
    readonly type: string;
    readonly baseUnit: string;
    readonly trackInventory: boolean;
    readonly price: string | null;
    readonly priceVersion: number;
  })[];
  readonly categories: readonly ConfiguredResource[];
  readonly branches: readonly ConfiguredResource[];
  readonly cashRegisters: readonly (ConfiguredResource & { readonly branchId: string })[];
  readonly paymentMethods: readonly string[];
}

export interface SignedConfiguration {
  readonly canonicalPayload: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly signature: string;
  readonly snapshot: ConfigurationSnapshot;
  readonly version: number;
}

export class ConfigurationVersionError extends Error {
  constructor(
    readonly code: 'CONFIGURATION_FORBIDDEN' | 'CONFIGURATION_GRANT_INVALID' |
      'CONFIGURATION_SIGNATURE_INVALID' | 'CONFIGURATION_BARRIER_ACTIVE',
    message: string,
  ) {
    super(message);
    this.name = 'ConfigurationVersionError';
  }
}

export class ConfigurationVersionService {
  constructor(
    private readonly transactions: TenantTransaction,
    private readonly signer: ConfigurationSigner,
  ) {}

  async issue(context: TenantTransactionContext): Promise<SignedConfiguration> {
    const configurationId = randomUUID();
    return this.transactions.run(context, {
      action: 'configuration.version_issued',
      after: {}, afterAllowlist: [], before: {}, beforeAllowlist: [],
      branchId: null, context: {}, contextAllowlist: [],
      entityId: configurationId, entityType: 'configuration_version', operationId: configurationId,
    }, async (client) => {
      const membership = await client.query<{ role: string }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2
         AND status = 'ACTIVE' AND revoked_at IS NULL`,
        [context.organizationId, context.userId],
      );
      if (!['OWNER', 'ADMIN'].includes(membership.rows[0]?.role ?? '')) {
        throw new ConfigurationVersionError('CONFIGURATION_FORBIDDEN', 'Solo OWNER o ADMIN pueden emitir configuración.');
      }
      const org = await client.query<{ base_currency: string }>(
        'SELECT base_currency FROM organizations WHERE id = $1 FOR UPDATE',
        [context.organizationId],
      );
      const currency = org.rows[0]?.base_currency;
      if (!currency) throw new ConfigurationVersionError('CONFIGURATION_FORBIDDEN', 'La organización no está disponible.');
      const barrier = await client.query(
        `SELECT 1 FROM configuration_barriers WHERE organization_id = $1 AND status = 'ACTIVE'`,
        [context.organizationId],
      );
      if ((barrier.rowCount ?? 0) > 0) {
        throw new ConfigurationVersionError('CONFIGURATION_BARRIER_ACTIVE', 'La barrera impide emitir versiones nuevas.');
      }
      const latest = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0)::integer AS version FROM configuration_versions
         WHERE organization_id = $1`,
        [context.organizationId],
      );
      const version = (latest.rows[0]?.version ?? 0) + 1;
      const items = await client.query<{
        id: string; type: string; baseUnit: string; trackInventory: boolean;
        price: string | null; priceVersion: number;
      }>(
          `SELECT id, type, base_unit AS "baseUnit", track_inventory AS "trackInventory",
                  price::text AS price, price_version::integer AS "priceVersion"
           FROM catalog_items WHERE organization_id = $1 AND status = 'ACTIVE' ORDER BY id`,
          [context.organizationId],
        );
      const categories = await client.query<ConfiguredResource>(
          `SELECT id FROM catalog_categories WHERE organization_id = $1 AND status = 'ACTIVE' ORDER BY id`,
          [context.organizationId],
        );
      const branches = await client.query<ConfiguredResource>(
          `SELECT id FROM branches WHERE organization_id = $1 AND status = 'ACTIVE' ORDER BY id`,
          [context.organizationId],
        );
      const cashRegisters = await client.query<ConfiguredResource & { branchId: string }>(
          `SELECT r.id, r.branch_id AS "branchId" FROM cash_registers r
           JOIN branches b ON b.organization_id = r.organization_id AND b.id = r.branch_id
           WHERE r.organization_id = $1 AND r.status = 'ACTIVE' AND b.status = 'ACTIVE' ORDER BY r.id`,
          [context.organizationId],
        );
      const paymentMethods = await client.query<{ method: string }>(
          `SELECT method FROM payment_method_settings WHERE organization_id = $1 AND enabled = true ORDER BY method`,
          [context.organizationId],
        );
      const snapshot: ConfigurationSnapshot = {
        currency,
        items: items.rows,
        categories: categories.rows,
        branches: branches.rows,
        cashRegisters: cashRegisters.rows,
        paymentMethods: paymentMethods.rows.map((row) => row.method),
      };
      const canonicalPayload = JSON.stringify({ organizationId: context.organizationId, version, snapshot });
      const signature = this.signer.sign(canonicalPayload);
      const verifier = createVerify('SHA256');
      verifier.update(canonicalPayload);
      verifier.end();
      if (!verifier.verify(this.signer.publicKeyPem, Buffer.from(signature, 'base64'))) {
        throw new ConfigurationVersionError('CONFIGURATION_SIGNATURE_INVALID', 'La firma de configuración no es válida.');
      }
      await client.query(
        `INSERT INTO configuration_versions
           (id, organization_id, version, snapshot, canonical_payload, signature, signing_key_id, public_key_pem)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        [configurationId, context.organizationId, version, JSON.stringify(snapshot), canonicalPayload,
          signature, this.signer.keyId, this.signer.publicKeyPem],
      );
      return { canonicalPayload, keyId: this.signer.keyId, publicKeyPem: this.signer.publicKeyPem,
        signature, snapshot, version };
    });
  }

  async recordExposure(context: TenantTransactionContext, grantId: string): Promise<{ readonly id: string; readonly version: number }> {
    return this.transactions.run(context, {
      action: 'configuration.grant_exposed',
      after: {}, afterAllowlist: [], before: {}, beforeAllowlist: [],
      branchId: null, context: {}, contextAllowlist: [],
      entityId: grantId, entityType: 'offline_grant', operationId: grantId,
    }, async (client) => {
      const membership = await client.query(
        `SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2
         AND status = 'ACTIVE' AND revoked_at IS NULL`,
        [context.organizationId, context.userId],
      );
      if ((membership.rowCount ?? 0) === 0) {
        throw new ConfigurationVersionError('CONFIGURATION_FORBIDDEN', 'La membresía no está activa.');
      }
      await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [context.organizationId]);
      const barrier = await client.query(
        `SELECT 1 FROM configuration_barriers WHERE organization_id = $1 AND status = 'ACTIVE'`,
        [context.organizationId],
      );
      if ((barrier.rowCount ?? 0) > 0) {
        throw new ConfigurationVersionError('CONFIGURATION_BARRIER_ACTIVE', 'La barrera impide nuevas exposiciones.');
      }
      return recordConfigurationExposure(client, context.organizationId, grantId);
    });
  }
}

export async function recordConfigurationExposure(
  client: PoolClient,
  organizationId: string,
  grantId: string,
): Promise<{ readonly id: string; readonly version: number }> {
  const exposureId = randomUUID();
  const grant = await client.query<{
    device_id: string; epoch: number; configuration_version: number;
    snapshot: ConfigurationSnapshot;
  }>(
        `SELECT g.device_id, g.epoch::integer AS epoch,
                g.configuration_version::integer AS configuration_version, v.snapshot
         FROM offline_grants g
         JOIN devices d ON d.organization_id = g.organization_id AND d.id = g.device_id
         JOIN configuration_versions v ON v.organization_id = g.organization_id
           AND v.version = g.configuration_version
         WHERE g.organization_id = $1 AND g.id = $2 AND g.revoked_at IS NULL
           AND g.closed_at IS NULL
           AND g.expires_at > now() AND d.status = 'ACTIVE'`,
        [organizationId, grantId],
      );
  const current = grant.rows[0];
  if (!current) throw new ConfigurationVersionError('CONFIGURATION_GRANT_INVALID', 'El grant no está vigente.');
  const inserted = await client.query<{ id: string }>(
        `INSERT INTO offline_configuration_exposures
           (id, organization_id, device_id, grant_id, epoch, configuration_version)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (organization_id, grant_id) DO NOTHING RETURNING id`,
        [exposureId, organizationId, current.device_id, grantId, current.epoch,
          current.configuration_version],
      );
  if (inserted.rows[0]) {
    const resourceRows: { catalog_item_id?: string; catalog_category_id?: string;
          branch_id?: string; cash_register_id?: string; payment_method?: string }[] = [
          ...current.snapshot.items.map((item) => ({ catalog_item_id: item.id })),
          ...current.snapshot.categories.map((category) => ({ catalog_category_id: category.id })),
          ...current.snapshot.branches.map((branch) => ({ branch_id: branch.id })),
          ...current.snapshot.cashRegisters.map((register) => ({ cash_register_id: register.id })),
          ...current.snapshot.paymentMethods.map((method) => ({ payment_method: method })),
        ];
    for (const resource of resourceRows) {
      await client.query(
            `INSERT INTO offline_exposure_resources
               (id, organization_id, exposure_id, catalog_item_id, catalog_category_id,
                branch_id, cash_register_id, payment_method)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [randomUUID(), organizationId, exposureId,
              resource.catalog_item_id ?? null, resource.catalog_category_id ?? null,
              resource.branch_id ?? null, resource.cash_register_id ?? null,
              resource.payment_method ?? null],
          );
    }
  }
  const persisted = inserted.rows[0] ?? (await client.query<{ id: string }>(
        `SELECT id FROM offline_configuration_exposures WHERE organization_id = $1 AND grant_id = $2`,
        [organizationId, grantId],
      )).rows[0];
  if (!persisted) throw new Error('La exposición no fue persistida.');
  return { id: persisted.id, version: current.configuration_version };
}
