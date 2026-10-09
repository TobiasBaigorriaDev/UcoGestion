import type { PoolClient } from 'pg';
export async function readBranchInventoryBlockers(client: PoolClient, organizationId: string, branchId: string): Promise<string> {
  return (await client.query<{ count: string }>("SELECT count(*)::text AS count FROM inventory_incidents WHERE organization_id=$1 AND branch_id=$2 AND status IN ('OPEN','PENDING_REVIEW')", [organizationId, branchId])).rows[0]?.count ?? '0';
}
