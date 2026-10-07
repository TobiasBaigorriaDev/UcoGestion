import { randomUUID } from 'node:crypto';
import { offlineConfirmedSaleSchema,sumMoney } from '@uconext/shared';
import type { PoolClient } from 'pg';
import { AuditEventWriter } from '../../core/audit/audit-event-writer.js';
import { IdempotencyService,toJsonValue } from '../../core/idempotency/idempotency.service.js';
import type { TenantTransactionContext } from '../../database/tenant-transaction.js';
import { lockOfflineSaleStock,applyOfflineSaleStock } from '../inventory/index.js';
export class OfflineSaleImporter {
  async apply(client:PoolClient,context:TenantTransactionContext,input:unknown,operationId:string) {
    const sale=offlineConfirmedSaleSchema.parse(input);
    if (sale.organizationId!==context.organizationId || sale.actorUserId!==context.userId) throw new Error('OFFLINE_SALE_SCOPE_INVALID');
    const session=(await client.query<{owner_user_id:string;status:string;currency_code:string;branch_id:string;device_id:string;cash_register_id:string}>(
      'SELECT owner_user_id,status,currency_code,branch_id,device_id,cash_register_id FROM cash_sessions WHERE organization_id=$1 AND id=$2 FOR UPDATE',
      [context.organizationId,sale.cashSessionId])).rows[0];
    if (!session || session.branch_id!==sale.branchId || session.device_id!==sale.deviceId || session.owner_user_id!==sale.actorUserId ||
      session.currency_code!==sale.quote.currency || !['OPEN','CONFLICTED'].includes(session.status)) throw new Error('OFFLINE_SALE_SESSION_INVALID');
    const idempotency=new IdempotencyService(client);
    const acquired=await idempotency.acquire({organizationId:context.organizationId,actorUserId:context.userId,
      scope:'offline.sale.confirm',authorizationClass:'OFFLINE_SALE_CONFIRM',branchId:sale.branchId,key:operationId,payload:toJsonValue(sale)},async()=>{});
    if (acquired.kind==='replay') return acquired.response.body;
    await lockOfflineSaleStock(client,context.organizationId,operationId,sale.quote.lines.filter(line=>line.trackInventory).map(line=>line.itemId));
    const receipt={label:'Comprobante no fiscal',branch:{name:sale.receipt.branchName},customer:null,currency:sale.quote.currency,
      subtotal:sale.quote.subtotal,discount:sale.quote.discount,total:sale.quote.total,
      items:sale.quote.lines.map(line=>({...line,name:line.itemName,unit:line.baseUnit})),payments:sale.payments};
    const received=(await client.query<{received_at:Date}>('SELECT received_at FROM sync_operations WHERE organization_id=$1 AND id=$2',[context.organizationId,operationId])).rows[0];
    if (!received) throw new Error('OFFLINE_SALE_RECEIPT_MISSING');
    await client.query(`INSERT INTO sales (id,organization_id,branch_id,cash_session_id,device_id,actor_user_id,session_owner_user_id,
      client_operation_id,currency_code,subtotal,discount,total,receipt_snapshot,offline_operation_id,local_reference,occurred_at,received_at)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12::jsonb,$7,$13,$14,$15)`,
    [sale.id,context.organizationId,sale.branchId,sale.cashSessionId,sale.deviceId,context.userId,operationId,sale.quote.currency,
      sale.quote.subtotal,sale.quote.discount,sale.quote.total,JSON.stringify(receipt),sale.localReference,sale.occurredAt,received.received_at]);
    await client.query("INSERT INTO organization_history_references (id,organization_id,reference_domain,reference_type,source_id) VALUES ($1,$2,'MONETARY','SALE',$3)",[randomUUID(),context.organizationId,sale.id]);
    const resources=[{column:'branch_id',id:sale.branchId},{column:'cash_register_id',id:session.cash_register_id},
      ...[...new Set(sale.payments.map(payment=>payment.method))].map(method=>({column:'payment_method',id:method})),
      ...[...new Set(sale.quote.lines.map(line=>line.itemId))].map(id=>({column:'catalog_item_id',id}))];
    for (const resource of resources) await client.query(`INSERT INTO resource_history_references (id,organization_id,reference_type,source_id,${resource.column}) VALUES ($1,$2,'SALE',$3,$4)`,[randomUUID(),context.organizationId,sale.id,resource.id]);
    const incidents:string[]=[];
    for (const line of sale.quote.lines) {
      const id=randomUUID();
      await client.query(`INSERT INTO sale_items (id,organization_id,sale_id,item_id,item_name,item_type,sku,barcode,unit,quantity,unit_price,price_version,line_total,currency_code,track_inventory)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[id,context.organizationId,sale.id,line.itemId,line.itemName,line.type,line.sku,line.barcode,line.baseUnit,line.quantity,line.unitPrice,line.priceVersion,line.lineTotal,sale.quote.currency,line.trackInventory]);
      if (line.trackInventory) {const incident=await applyOfflineSaleStock(client,context.organizationId,sale.id,id);if (incident) incidents.push(incident);}
    }
    for (const payment of sale.payments) await client.query(`INSERT INTO sale_payments (id,organization_id,sale_id,method,applied_amount,received_amount,change_amount,currency_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),context.organizationId,sale.id,payment.method,payment.appliedAmount,payment.receivedAmount,payment.changeAmount,sale.quote.currency]);
    const cash=sumMoney(sale.payments.filter(row=>row.method==='CASH').map(row=>row.appliedAmount));
    if (cash!=='0.00') await client.query(`INSERT INTO cash_movements (id,organization_id,branch_id,cash_session_id,actor_user_id,device_id,delta,currency_code,source_type,source_id,effect_kind)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SALE',$9,'IN')`,[randomUUID(),context.organizationId,sale.branchId,sale.cashSessionId,context.userId,sale.deviceId,cash,sale.quote.currency,sale.id]);
    await new AuditEventWriter(client).append({action:'sale.confirmed.offline',organizationId:context.organizationId,actorUserId:context.userId,
      branchId:sale.branchId,deviceId:sale.deviceId,entityType:'sale',entityId:sale.id,operationId,requestId:context.requestId,
      before:{},beforeAllowlist:[],after:{total:sale.quote.total,incidents:[...new Set(incidents)]},afterAllowlist:['total','incidents'],
      context:{configurationVersion:sale.configurationVersion},contextAllowlist:['configurationVersion']});
    const result={id:sale.id,reference:sale.id,localReference:sale.localReference,incidents:[...new Set(incidents)]};
    await idempotency.complete(acquired.record.id,{statusCode:200,body:result});return result;
  }
}
