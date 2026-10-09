import type { PoolClient } from 'pg';
export async function readBranchCashBlockers(client: PoolClient, organizationId: string, branchId: string): Promise<string> {
  return (await client.query<{ count: string }>("SELECT count(*)::text AS count FROM cash_sessions WHERE organization_id=$1 AND branch_id=$2 AND status IN ('OPEN','CLOSING','CONFLICTED')", [organizationId, branchId])).rows[0]?.count ?? '0';
}
