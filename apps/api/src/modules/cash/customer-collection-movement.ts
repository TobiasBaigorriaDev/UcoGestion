import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDevicePolicy } from './cash-session-device.policy.js';

export class CustomerCollectionCashError extends Error {
  readonly code = 'CUSTOMER_ACCOUNT_CASH_INSUFFICIENT';
  constructor() { super('La caja no tiene efectivo suficiente para revertir el cobro.'); }
}

/** Public cash port; caller supplies the same contextual transaction as the account ledger. */
export async function recordCustomerCollectionCash(client: PoolClient, context: TenantTransactionContext,
  input: { cashSessionId: string; deviceId: string; amount: string; currency: string; entryId: string; reversal: boolean }) {
  const session = await new CashSessionDevicePolicy().requireAuthorizedActor(client, context,
    input.cashSessionId, input.deviceId);
  if (input.reversal) {
    const cash = await client.query<{ enough: boolean }>(`SELECT expected_cash >= $3::numeric AS enough
      FROM cash_sessions WHERE organization_id=$1 AND id=$2`, [context.organizationId, input.cashSessionId, input.amount]);
    if (!cash.rows[0]?.enough) throw new CustomerCollectionCashError();
  }
  await client.query(`INSERT INTO cash_movements (id,organization_id,branch_id,cash_session_id,actor_user_id,
    device_id,delta,currency_code,source_type,source_id,effect_kind)
    VALUES ($1,$2,$3,$4,$5,$6,$7::numeric * $8,$9,'CUSTOMER_COLLECTION',$10,$11)`,
  [randomUUID(), context.organizationId, session.branchId, input.cashSessionId, context.userId, input.deviceId,
    input.amount, input.reversal ? -1 : 1, input.currency, input.entryId, input.reversal ? 'OUT' : 'IN']);
}
