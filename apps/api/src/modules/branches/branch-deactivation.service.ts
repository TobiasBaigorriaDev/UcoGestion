import type { PoolClient } from 'pg';
import { z } from 'zod';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { readBranchCashBlockers } from '../cash/index.js';
import { readBranchOfflineBlockers } from '../offline-sync/index.js';
import { readBranchInventoryBlockers } from '../inventory/index.js';

const resultSchema = z.object({ id: z.uuid(), name: z.string(), status: z.enum(['ACTIVE','INACTIVE']), version: z.number().int() });
export class BranchDeactivationError extends Error {
  constructor(readonly code: 'BRANCH_DEACTIVATION_FORBIDDEN' | 'BRANCH_NOT_AVAILABLE' | 'BRANCH_VERSION_CONFLICT' | 'BRANCH_DEACTIVATION_BLOCKED' | 'BRANCH_RETRY_REQUIRED', message: string) { super(message); }
}
export interface BranchDeactivationBlockers { readonly sessions: string; readonly pending: string; readonly conflicts: string; readonly uncertainty: string }
export class BranchDeactivationService {
  constructor(private readonly transactions: TenantTransaction) {}
  async blockers(context: TenantTransactionContext, branchId: string): Promise<BranchDeactivationBlockers> {
    return this.transactions.read(context, async client => {
      await this.requireOwner(client, context, branchId);
      return this.readBlockers(client, context.organizationId, branchId);
    });
  }
  async deactivate(context: TenantTransactionContext, branchId: string, expectedVersion: number, key: string) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.transactions.runIdempotent(context, {
          action: 'branch.deactivated', entityType: 'branch', entityId: branchId, operationId: branchId, branchId,
          before: { status: 'ACTIVE' }, after: { status: 'INACTIVE' }, beforeAllowlist: ['status'], afterAllowlist: ['status'], context: {}, contextAllowlist: [],
        }, { organizationId: context.organizationId, actorUserId: context.userId, authorizationClass: 'BRANCH_DEACTIVATION', branchId,
          key, scope: 'branch.deactivate', payload: { branchId, expectedVersion } }, async client => {
          await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [context.organizationId]);
          await this.requireOwner(client, context, branchId, true);
        }, async client => {
          const row = (await client.query<z.infer<typeof resultSchema>>('SELECT id,name,status,version::integer AS version FROM branches WHERE organization_id=$1 AND id=$2 FOR UPDATE', [context.organizationId, branchId])).rows[0];
          if (!row) throw new BranchDeactivationError('BRANCH_NOT_AVAILABLE', 'Sucursal no disponible.');
          if (row.version !== expectedVersion || row.status !== 'ACTIVE') throw new BranchDeactivationError('BRANCH_VERSION_CONFLICT', 'La sucursal cambió. Actualizá sus datos.');
          const blockers = await this.readBlockers(client, context.organizationId, branchId);
          if (Object.values(blockers).some(value => value !== '0')) throw new BranchDeactivationError('BRANCH_DEACTIVATION_BLOCKED', 'Cerrá las sesiones, sincronizá los equipos y resolvé los conflictos. La incertidumbre offline exige completar una barrera de configuración; la revocación o el vencimiento no la eliminan.');
          return resultSchema.parse((await client.query("UPDATE branches SET status='INACTIVE',version=version+1 WHERE organization_id=$1 AND id=$2 RETURNING id,name,status,version::integer AS version", [context.organizationId,branchId])).rows[0]);
        }, resultSchema.parse);
      } catch (error) {
        const code = error instanceof Object && 'code' in error ? error.code : undefined;
        if (code !== '40P01' && code !== '40001') throw error;
        if (attempt === 3) throw new BranchDeactivationError('BRANCH_RETRY_REQUIRED', 'La operación compitió con otra. Reintentá con la misma clave.');
        await new Promise(resolve => setTimeout(resolve, attempt * 5));
      }
    }
    throw new BranchDeactivationError('BRANCH_RETRY_REQUIRED', 'Reintentá con la misma clave.');
  }
  private async requireOwner(client: PoolClient, context: TenantTransactionContext, branchId: string, lock = false) {
    const actor = (await client.query<{ role: string }>(`SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='ACTIVE' AND revoked_at IS NULL ${lock ? 'FOR SHARE' : ''}`, [context.organizationId, context.userId])).rows[0];
    if (actor?.role !== 'OWNER') throw new BranchDeactivationError('BRANCH_DEACTIVATION_FORBIDDEN', 'Solo OWNER puede desactivar sucursales.');
    if (!(await client.query('SELECT id FROM branches WHERE organization_id=$1 AND id=$2', [context.organizationId,branchId])).rowCount) throw new BranchDeactivationError('BRANCH_NOT_AVAILABLE', 'Sucursal no disponible.');
  }
  private async readBlockers(client: PoolClient, organizationId: string, branchId: string): Promise<BranchDeactivationBlockers> {
    const sessions = await readBranchCashBlockers(client, organizationId, branchId);
    const offline = await readBranchOfflineBlockers(client, organizationId, branchId);
    const conflicts = await readBranchInventoryBlockers(client, organizationId, branchId);
    return { sessions, ...offline, conflicts };
  }
}
