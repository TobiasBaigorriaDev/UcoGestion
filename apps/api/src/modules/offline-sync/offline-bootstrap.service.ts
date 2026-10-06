import { createVerify, randomUUID } from 'node:crypto';

import { offlineBootstrapPayloadSchema } from '@uconext/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { recordConfigurationExposure, type ConfigurationSigner, type ConfigurationSnapshot } from './configuration-version.service.js';
import { preserveIngestionKeys } from './ingestion-key-retention.js';
import type { RsaSyncEnvelopeDecryptor } from './sync-envelope-decryptor.js';

export const signedBootstrapSchema = z.strictObject({ payload: z.string(), signature: z.string(), signingKeyId: z.string() });
export type SignedBootstrap = z.infer<typeof signedBootstrapSchema>;
export interface BootstrapInput { readonly deviceId: string; readonly branchId: string }

export class OfflineBootstrapError extends Error {
  constructor(readonly code: 'OFFLINE_BOOTSTRAP_FORBIDDEN' | 'OFFLINE_BARRIER_ACTIVE' | 'OFFLINE_SIGNATURE_INVALID', message: string) {
    super(message);
  }
}

interface Actor { id: string; role: string }
interface Organization { config_epoch: string; base_currency: string; timezone: string }

export class OfflineBootstrapService {
  constructor(private readonly transactions: TenantTransaction, private readonly signer: ConfigurationSigner,
    private readonly ingestion: Pick<RsaSyncEnvelopeDecryptor, 'publication' | 'backup'>) {}

  async issue(context: TenantTransactionContext, input: BootstrapInput, key: string): Promise<SignedBootstrap> {
    const grantId = randomUUID();
    return this.transactions.runIdempotent(context, {
      action: 'offline.bootstrap_issued', entityType: 'offline_grant', entityId: grantId, operationId: grantId,
      branchId: input.branchId, deviceId: input.deviceId, before: {}, after: {}, context: {},
      beforeAllowlist: [], afterAllowlist: [], contextAllowlist: [],
    }, {
      actorUserId: context.userId, organizationId: context.organizationId, authorizationClass: 'OFFLINE_BOOTSTRAP',
      branchId: input.branchId, scope: 'offline.bootstrap', key, payload: { ...input },
    }, async (client) => { await authorizeOfflinePos(client, context, input); }, async (client) => {
      const actor = await authorizeOfflinePos(client, context, input);
      await preserveIngestionKeys(client, this.ingestion.backup());
      const organization = (await client.query<Organization>(
        'SELECT config_epoch::text, base_currency, timezone FROM organizations WHERE id = $1', [context.organizationId],
      )).rows[0];
      if (!organization) throw new OfflineBootstrapError('OFFLINE_BOOTSTRAP_FORBIDDEN', 'Organización no disponible.');
      const barrier = await client.query("SELECT 1 FROM configuration_barriers WHERE organization_id = $1 AND status = 'ACTIVE'", [context.organizationId]);
      if (barrier.rowCount) throw new OfflineBootstrapError('OFFLINE_BARRIER_ACTIVE', 'La configuración está congelada.');
      const items = await client.query<ConfigurationSnapshot['items'][number] & {
        name: string; sku: string | null; barcode: string | null;
      }>(`SELECT id, name, sku, barcode, type, base_unit AS "baseUnit",
          track_inventory AS "trackInventory", price::text AS price, price_version::integer AS "priceVersion"
          FROM catalog_items WHERE organization_id = $1 AND status = 'ACTIVE' ORDER BY id`, [context.organizationId]);
      const categories = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM catalog_categories WHERE organization_id = $1 AND status = 'ACTIVE' ORDER BY id", [context.organizationId]);
      const branches = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM branches WHERE organization_id = $1 AND id = $2', [context.organizationId, input.branchId]);
      const registers = await client.query<{ id: string; name: string; branchId: string }>(
        `SELECT id, name, branch_id AS "branchId" FROM cash_registers
         WHERE organization_id = $1 AND branch_id = $2 AND status = 'ACTIVE' ORDER BY id`, [context.organizationId, input.branchId]);
      const methods = await client.query<{ method: string }>(
        'SELECT method FROM payment_method_settings WHERE organization_id = $1 AND enabled = true ORDER BY method', [context.organizationId]);
      const stocks = await client.query<{ itemId: string; quantity: string }>(
        `SELECT s.item_id AS "itemId", s.quantity::text AS quantity FROM branch_stocks s
         JOIN catalog_items i ON i.organization_id = s.organization_id AND i.id = s.item_id
         WHERE s.organization_id = $1 AND s.branch_id = $2 AND i.status = 'ACTIVE' ORDER BY s.item_id`, [context.organizationId, input.branchId]);
      const snapshot: ConfigurationSnapshot = { currency: organization.base_currency, items: items.rows,
        categories: categories.rows, branches: branches.rows, cashRegisters: registers.rows,
        paymentMethods: methods.rows.map(row => row.method) };
      const version = (await client.query<{ version: number }>(
        'SELECT (COALESCE(MAX(version), 0) + 1)::integer AS version FROM configuration_versions WHERE organization_id = $1',
        [context.organizationId],
      )).rows[0]?.version;
      if (!version) throw new Error('Configuration version unavailable.');
      const canonicalPayload = JSON.stringify({ organizationId: context.organizationId, version, snapshot });
      const signature = this.sign(canonicalPayload);
      await client.query(`INSERT INTO configuration_versions
        (id, organization_id, version, snapshot, canonical_payload, signature, signing_key_id, public_key_pem, config_epoch)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`, [randomUUID(), context.organizationId, version,
        JSON.stringify(snapshot), canonicalPayload, signature, this.signer.keyId, this.signer.publicKeyPem, organization.config_epoch]);
      // Reservation establishes D01 uncertainty; it is not a usable creation grant.
      await client.query(`INSERT INTO offline_grants (id, organization_id, device_id, epoch, configuration_version, expires_at)
        VALUES ($1, $2, $3, $4, $5, now() + interval '72 hours')`, [grantId, context.organizationId, input.deviceId,
        organization.config_epoch, version]);
      await recordConfigurationExposure(client, context.organizationId, grantId);
      const serverTime = (await client.query<{ time: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS time")).rows[0]?.time;
      const payload = JSON.stringify(offlineBootstrapPayloadSchema.parse({ version: 1, organizationId: context.organizationId, actorUserId: context.userId,
        deviceId: input.deviceId, branchId: input.branchId, grantId, epoch: organization.config_epoch,
        configurationVersion: String(version), configuration: snapshot, stock: stocks.rows, timezone: organization.timezone,
        role: actor.role, permissions: { canDiscount: ['OWNER', 'ADMIN'].includes(actor.role) },
        serverTime, ingestionKey: this.ingestion.publication(),
        ackKey: { keyId: this.signer.keyId, algorithm: 'ES256', publicKeyPem: this.signer.publicKeyPem } }));
      return { payload, signature: this.sign(payload), signingKeyId: this.signer.keyId };
    }, (body) => signedBootstrapSchema.parse(body));
  }

  private sign(payload: string): string {
    const signature = this.signer.sign(payload);
    const verifier = createVerify('sha256'); verifier.update(payload); verifier.end();
    if (!verifier.verify(this.signer.publicKeyPem, Buffer.from(signature, 'base64'))) {
      throw new OfflineBootstrapError('OFFLINE_SIGNATURE_INVALID', 'Firma de bootstrap inválida.');
    }
    return signature;
  }

}

export async function authorizeOfflinePos(client: PoolClient, context: TenantTransactionContext, input: BootstrapInput): Promise<Actor> {
    await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [context.organizationId]);
    const actor = (await client.query<Actor>(`SELECT m.id, m.role FROM memberships m
      WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE' AND m.revoked_at IS NULL
      FOR SHARE OF m`, [context.organizationId, context.userId])).rows[0];
    if (!actor || !['OWNER', 'ADMIN', 'CASHIER'].includes(actor.role)) {
      throw new OfflineBootstrapError('OFFLINE_BOOTSTRAP_FORBIDDEN', 'No podés preparar este POS.');
    }
    const available = await client.query(`SELECT d.id FROM devices d
      JOIN branches b ON b.organization_id = d.organization_id AND b.id = d.branch_id
      JOIN organizations o ON o.id = d.organization_id
      WHERE d.organization_id = $1 AND d.id = $2 AND d.branch_id = $3 AND d.status = 'ACTIVE'
      AND d.public_key_thumbprint IS NOT NULL AND b.status = 'ACTIVE' AND o.status = 'ACTIVE'
      AND EXISTS (SELECT 1 FROM effective_membership_branch_scope s
        WHERE s.organization_id = $1 AND s.membership_id = $4 AND s.branch_id = $3)
      FOR SHARE OF d, b`, [context.organizationId, input.deviceId, input.branchId, actor.id]);
    if (!available.rowCount) throw new OfflineBootstrapError('OFFLINE_BOOTSTRAP_FORBIDDEN', 'Dispositivo o sucursal no disponible.');
    return actor;
}
