import { offlineConfigurationSchema, offlineConfirmedSaleSchema } from '@uconext/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AuditEventWriter } from '../../core/audit/audit-event-writer.js';
import type { OpenedHistoricalEnvelope } from './historical-envelope-validator.js';

type Discrepancy = { resource: string; resourceId: string; field: string; historical: string | null; current: string | null };
type Item = { id: string; status: string; name: string; sku: string | null; barcode: string | null; type: string;
  baseUnit: string; trackInventory: boolean; unitPrice: string; priceVersion: number };

/** Diagnostic comparison only. The verified retained version determines every business effect. */
export async function recordConfigurationDiscrepancy(client: PoolClient, operation: OpenedHistoricalEnvelope['operation'], configuration: unknown): Promise<void> {
  const snapshot = offlineConfigurationSchema.parse(configuration), discrepancies: Discrepancy[] = [];
  const compare = (resource: string, resourceId: string, field: string, historical: string | number | boolean | null,
    current: string | number | boolean | null) => {
    const before = historical === null ? null : String(historical), after = current === null ? null : String(current);
    if (before !== after) discrepancies.push({resource,resourceId,field,historical:before,current:after});
  };
  const payload = operation.kind === 'sale-confirm' ? offlineConfirmedSaleSchema.parse(operation.payload)
    : z.object({branchId:z.uuid(),cashRegisterId:z.uuid()}).parse(operation.payload);
  const branch = (await client.query<{status:string;name:string}>(
    'SELECT status,name FROM branches WHERE organization_id=$1 AND id=$2',[operation.organizationId,payload.branchId])).rows[0];
  compare('BRANCH',payload.branchId,'status','ACTIVE',branch?.status ?? null);
  compare('BRANCH',payload.branchId,'name',snapshot.branches.find(row=>row.id===payload.branchId)?.name ?? null,branch?.name ?? null);
  const registerId = 'cashRegisterId' in payload ? payload.cashRegisterId
    : (await client.query<{cash_register_id:string}>('SELECT cash_register_id FROM cash_sessions WHERE organization_id=$1 AND id=$2',
      [operation.organizationId,payload.cashSessionId])).rows[0]?.cash_register_id;
  if (!registerId) throw new Error('OFFLINE_DISCREPANCY_CONTEXT_INVALID');
  const register = (await client.query<{status:string;name:string;branch_id:string}>(
    'SELECT status,name,branch_id FROM cash_registers WHERE organization_id=$1 AND id=$2',[operation.organizationId,registerId])).rows[0];
  compare('CASH_REGISTER',registerId,'status','ACTIVE',register?.status ?? null);
  compare('CASH_REGISTER',registerId,'name',snapshot.cashRegisters.find(row=>row.id===registerId)?.name ?? null,register?.name ?? null);
  compare('CASH_REGISTER',registerId,'branchId',payload.branchId,register?.branch_id ?? null);
  const organization = (await client.query<{base_currency:string}>('SELECT base_currency FROM organizations WHERE id=$1',[operation.organizationId])).rows[0];
  compare('ORGANIZATION',operation.organizationId,'currency',snapshot.currency,organization?.base_currency ?? null);
  if ('quote' in payload) {
    const items = await client.query<Item>(`SELECT id,status,name,sku,barcode,type,base_unit AS "baseUnit",
      track_inventory AS "trackInventory",price::text AS "unitPrice",price_version::integer AS "priceVersion"
      FROM catalog_items WHERE organization_id=$1 AND id=ANY($2::uuid[])`,[operation.organizationId,payload.quote.lines.map(line=>line.itemId)]);
    for (const line of payload.quote.lines) {
      const current = items.rows.find(row=>row.id===line.itemId);
      compare('CATALOG_ITEM',line.itemId,'status','ACTIVE',current?.status ?? null);
      for (const [field,before,after] of [
        ['name',line.itemName,current?.name],['sku',line.sku,current?.sku],['barcode',line.barcode,current?.barcode],
        ['type',line.type,current?.type],['baseUnit',line.baseUnit,current?.baseUnit],
        ['trackInventory',line.trackInventory,current?.trackInventory],['unitPrice',line.unitPrice,current?.unitPrice],
        ['priceVersion',line.priceVersion,current?.priceVersion],
      ] as const) compare('CATALOG_ITEM',line.itemId,field,before,after ?? null);
    }
    const methods = await client.query<{method:string;enabled:boolean}>(
      'SELECT method,enabled FROM payment_method_settings WHERE organization_id=$1',[operation.organizationId]);
    for (const method of [...new Set(payload.payments.map(payment=>payment.method))]) {
      compare('PAYMENT_METHOD',method,'enabled',true,methods.rows.find(row=>row.method===method)?.enabled ?? null);
    }
  }
  if (!discrepancies.length) return;
  await new AuditEventWriter(client).append({organizationId:operation.organizationId,actorUserId:operation.actorId,
    requestId:operation.id,operationId:operation.id,entityType:'sync_operation',entityId:operation.id,
    action:'offline.configuration_discrepancy',branchId:payload.branchId,deviceId:operation.deviceId,
    before:{},after:{},context:{configurationVersion:operation.configVersion,discrepancies},
    beforeAllowlist:[],afterAllowlist:[],contextAllowlist:['configurationVersion','discrepancies']});
}
