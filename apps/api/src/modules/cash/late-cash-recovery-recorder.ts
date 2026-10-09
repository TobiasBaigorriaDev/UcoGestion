import type { PoolClient } from 'pg';
import { AuditEventWriter } from '../../core/audit/audit-event-writer.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';

/** Public cash port: caller has historically validated and persisted the sale in this transaction. */
export async function recordLateCashRecovery(client:PoolClient,context:TenantTransactionContext,
  input:{cashSessionId:string;saleId:string;operationId:string;deviceId:string;branchId:string}):Promise<void> {
  const session=(await client.query<{expected_cash:string}>(`SELECT cs.expected_cash FROM cash_sessions cs
    JOIN cash_exceptional_closures c ON c.organization_id=cs.organization_id AND c.cash_session_id=cs.id
    WHERE cs.organization_id=$1 AND cs.id=$2 AND cs.status='CLOSED_WITH_UNRECOVERED_DEVICE' AND cs.completeness='UNKNOWN'`,
    [context.organizationId,input.cashSessionId])).rows[0];
  if (!session) throw new Error('CASH_LATE_RECOVERY_INVALID');
  await client.query(`INSERT INTO cash_late_recoveries (organization_id,operation_id,cash_session_id,sale_id,expected_cash_known)
    VALUES ($1,$2,$3,$4,$5)`,[context.organizationId,input.operationId,input.cashSessionId,input.saleId,session.expected_cash]);
  await new AuditEventWriter(client).append({organizationId:context.organizationId,actorUserId:context.userId,requestId:context.requestId,
    action:'cash.late_operations_recovered',entityType:'cash_session',entityId:input.cashSessionId,operationId:input.operationId,
    branchId:input.branchId,deviceId:input.deviceId,before:{},beforeAllowlist:[],
    after:{marker:'LATE_RECOVERED_OPERATIONS',expectedCashKnown:session.expected_cash,review:'PENDING_REVIEW'},
    afterAllowlist:['marker','expectedCashKnown','review'],context:{saleId:input.saleId},contextAllowlist:['saleId']});
}
