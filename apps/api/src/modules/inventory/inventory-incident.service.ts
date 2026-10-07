import type { PoolClient } from 'pg';
import { z } from 'zod';
import { TenantTransaction,type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { retryInventoryTransaction } from './inventory-transaction-retry.js';
const resultSchema=z.strictObject({id:z.uuid(),status:z.literal('RESOLVED')});
export class InventoryIncidentService {
  constructor(private readonly transactions:TenantTransaction) {}
  async resolve(context:TenantTransactionContext,id:string,note:string,key:string) {
    const canonicalNote=note.trim();
    if (!canonicalNote || canonicalNote.length>2000) throw new RangeError('La nota de resolución es obligatoria.');
    const authorize=async(client:PoolClient)=>{
      const result=await client.query(`SELECT i.id,i.branch_id FROM inventory_incidents i JOIN memberships m ON m.organization_id=i.organization_id
        WHERE i.organization_id=$1 AND i.id=$2 AND m.user_id=$3 AND m.status='ACTIVE' AND m.revoked_at IS NULL
        AND m.role IN ('OWNER','ADMIN') AND (m.role='OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope s
        WHERE s.organization_id=m.organization_id AND s.membership_id=m.id AND s.branch_id=i.branch_id))`,[context.organizationId,id,context.userId]);
      if (!result.rows[0]) throw new Error('incident resolution forbidden');
      return String(result.rows[0].branch_id);
    };
    const branchId=await this.transactions.read(context,authorize);
    return retryInventoryTransaction(()=>this.transactions.runIdempotent(context,{action:'inventory.incident.resolved',entityType:'inventory_incident',
      entityId:id,operationId:id,branchId,before:{},beforeAllowlist:[],after:{status:'RESOLVED',note:canonicalNote},afterAllowlist:['status','note'],context:{},contextAllowlist:[]},
    {organizationId:context.organizationId,actorUserId:context.userId,authorizationClass:'INVENTORY_INCIDENT_RESOLVE',branchId,
      scope:'inventory.incident.resolve',key,payload:{id,note:canonicalNote}},async client=>{await authorize(client);},async client=>{
      const balance=await client.query<{nonnegative:boolean}>('SELECT inventory_api.lock_incident_stock($1,$2)>=0 AS nonnegative',[context.organizationId,id]);
      const incident=(await client.query<{status:string;branch_id:string}>(
        'SELECT status,branch_id FROM inventory_incidents WHERE organization_id=$1 AND id=$2 FOR UPDATE',[context.organizationId,id])).rows[0];
      if (!incident || incident.status!=='PENDING_REVIEW' || !balance.rows[0]?.nonnegative) throw new Error('INCIDENT_NOT_REVIEWABLE');
      await client.query("UPDATE inventory_incidents SET status='RESOLVED',note=$3,resolved_by_user_id=$4,resolved_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",[context.organizationId,id,canonicalNote,context.userId]);
      return resultSchema.parse({id,status:'RESOLVED'});
    },body=>resultSchema.parse(body)));
  }
}
