import type { PoolClient } from 'pg';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';

export async function reverseSaleStock(client: PoolClient, context: TenantTransactionContext, saleId: string, cancellationId: string): Promise<void> {
  await client.query('SELECT inventory_api.reverse_sale_stock($1,$2,$3,$4)',
    [context.organizationId,saleId,cancellationId,context.userId]);
}
