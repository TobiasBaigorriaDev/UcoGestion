import type { PoolClient } from 'pg';
export async function readBranchOfflineBlockers(client: PoolClient, organizationId: string, branchId: string): Promise<{ pending: string; uncertainty: string }> {
  const pending = (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM sync_operations s
    JOIN devices d ON d.organization_id=s.organization_id AND d.id=s.device_id
    WHERE s.organization_id=$1 AND d.branch_id=$2 AND s.status='PENDING'`, [organizationId, branchId])).rows[0]?.count ?? '0';
  const uncertainty = (await client.query<{ count: string }>(`SELECT count(DISTINCT e.id)::text AS count FROM offline_configuration_exposures e
    JOIN offline_exposure_resources r ON r.organization_id=e.organization_id AND r.exposure_id=e.id
    LEFT JOIN cash_registers cr ON cr.organization_id=r.organization_id AND cr.id=r.cash_register_id
    WHERE e.organization_id=$1 AND e.cleared_at IS NULL AND (r.branch_id=$2 OR cr.branch_id=$2)`, [organizationId, branchId])).rows[0]?.count ?? '0';
  return { pending, uncertainty };
}
