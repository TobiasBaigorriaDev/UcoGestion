import type { PoolClient } from 'pg';
/** Public inventory application port. Callers hold the cash session lock and
 * acquire the complete item set in canonical order before applying any line. */
export async function lockOfflineSaleStock(client:PoolClient,organizationId:string,operationId:string,itemIds:readonly string[]) {
  for (const itemId of [...new Set(itemIds)].sort()) await client.query('SELECT inventory_api.lock_offline_sale_stock($1,$2,$3)',[organizationId,operationId,itemId]);
}
export async function applyOfflineSaleStock(client:PoolClient,organizationId:string,saleId:string,lineId:string):Promise<string|null> {
  return (await client.query<{incident:string|null}>('SELECT inventory_api.apply_offline_sale_stock($1,$2,$3) AS incident',[organizationId,saleId,lineId])).rows[0]?.incident ?? null;
}
