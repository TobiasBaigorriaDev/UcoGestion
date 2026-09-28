import { randomUUID } from 'node:crypto';

import { calculateSaleLine, Quantity, sumMoney, validateNonNegativeMoney,
  type QuantityUnit } from '@uconext/shared';
import type { PoolClient } from 'pg';

import type { TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface PurchaseLineInput {
  readonly itemId: string;
  readonly quantity: string;
  readonly unitCost: string;
}

export interface PendingPurchaseInput {
  readonly id: string;
  readonly branchId: string;
  readonly supplierId: string;
  readonly clientOperationId: string;
  readonly lines: readonly PurchaseLineInput[];
}

export class PurchasePersistenceError extends Error {
  constructor(readonly code: 'PURCHASE_SUPPLIER_NOT_AVAILABLE' | 'PURCHASE_BRANCH_NOT_AVAILABLE'
    | 'PURCHASE_ITEM_NOT_AVAILABLE' | 'PURCHASE_LINE_INVALID' | 'PURCHASE_TOTAL_OUT_OF_RANGE', message: string) {
    super(message); this.name = 'PurchasePersistenceError';
  }
}

interface CatalogRow {
  id: string; name: string; type: string; sku: string | null; barcode: string | null;
  base_unit: QuantityUnit; track_inventory: boolean;
}

/** Persists an already authorized purchase inside the caller's tenant transaction. */
export class PurchasePersistence {
  async persistPending(client: PoolClient, context: TenantTransactionContext,
    input: PendingPurchaseInput): Promise<{ id: string; total: string; currency: string }> {
    return this.persist(client, context, input, 'PENDING_PAYMENT');
  }

  async persistPaid(client: PoolClient, context: TenantTransactionContext,
    input: PendingPurchaseInput): Promise<{ id: string; total: string; currency: string }> {
    return this.persist(client, context, input, 'PAID');
  }

  private async persist(client: PoolClient, context: TenantTransactionContext,
    input: PendingPurchaseInput, status: 'PENDING_PAYMENT' | 'PAID'):
    Promise<{ id: string; total: string; currency: string }> {
    if (input.lines.length === 0) {
      throw new PurchasePersistenceError('PURCHASE_LINE_INVALID', 'La compra requiere al menos un producto.');
    }
    const branch = await client.query<{ currency: string }>(`SELECT o.base_currency AS currency
      FROM branches b JOIN organizations o ON o.id = b.organization_id
      WHERE b.organization_id = $1 AND b.id = $2 AND b.status = 'ACTIVE'`,
    [context.organizationId, input.branchId]);
    const currency = branch.rows[0]?.currency;
    if (!currency) throw new PurchasePersistenceError('PURCHASE_BRANCH_NOT_AVAILABLE', 'La sucursal no está disponible.');
    const suppliers = await client.query<{ name: string; tax_id: string | null;
      contact: string | null; address: string | null }>(`SELECT name, tax_id, contact, address FROM suppliers
      WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE' FOR SHARE`,
    [context.organizationId, input.supplierId]);
    const supplier = suppliers.rows[0];
    if (!supplier) {
      throw new PurchasePersistenceError('PURCHASE_SUPPLIER_NOT_AVAILABLE', 'El proveedor no está disponible.');
    }
    const ids = [...new Set(input.lines.map((line) => line.itemId))].sort();
    const catalog = await client.query<CatalogRow>(`SELECT id, name, type, sku, barcode, base_unit,
      track_inventory FROM catalog_items WHERE organization_id = $1 AND id = ANY($2::uuid[])
      AND status = 'ACTIVE' AND type = 'PRODUCT' ORDER BY id FOR SHARE`, [context.organizationId, ids]);
    const items = new Map(catalog.rows.map((item) => [item.id, item]));
    if (items.size !== ids.length) {
      throw new PurchasePersistenceError('PURCHASE_ITEM_NOT_AVAILABLE', 'Un producto no está disponible.');
    }
    const lines = input.lines.map((line) => {
      const item = items.get(line.itemId);
      if (!item) throw new PurchasePersistenceError('PURCHASE_ITEM_NOT_AVAILABLE', 'Un producto no está disponible.');
      try {
        const quantity = Quantity.from(line.quantity, item.base_unit).toString();
        const unitCost = validateNonNegativeMoney(line.unitCost);
        if (!unitCost || !/^(?:0|[1-9]\d{0,16})(?:\.\d{1,3})?$/.test(quantity)
          || !/^(?:0|[1-9]\d{0,17})\.\d{2}$/.test(unitCost)) throw new RangeError();
        const lineTotal = calculateSaleLine(quantity, unitCost);
        if (!/^(?:0|[1-9]\d{0,17})\.\d{2}$/.test(lineTotal)) throw new RangeError();
        return { item, quantity, unitCost, lineTotal };
      } catch {
        throw new PurchasePersistenceError('PURCHASE_LINE_INVALID', 'La cantidad o el costo no es válido.');
      }
    });
    const total = sumMoney(lines.map((line) => line.lineTotal));
    if (!/^(?:0|[1-9]\d{0,17})\.\d{2}$/.test(total)) {
      throw new PurchasePersistenceError('PURCHASE_TOTAL_OUT_OF_RANGE', 'El total supera la precisión admitida.');
    }
    await client.query(`INSERT INTO purchases (id, organization_id, branch_id, supplier_id,
      actor_user_id, client_operation_id, confirmation_status, currency_code, total, supplier_snapshot)
      VALUES ($1, $2, $3, $4, $5, $6, $10, $7, $8, $9::jsonb)`,
    [input.id, context.organizationId, input.branchId, input.supplierId, context.userId,
      input.clientOperationId, currency, total, JSON.stringify(supplier), status]);
    for (const line of lines) {
      await client.query(`INSERT INTO purchase_items (id, organization_id, purchase_id, item_id,
        item_name, item_type, sku, barcode, unit, category_id, category_name, track_inventory,
        quantity, unit_cost, line_total, currency_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, $10, $11, $12, $13, $14)`,
      [randomUUID(), context.organizationId, input.id, line.item.id, line.item.name, line.item.type,
        line.item.sku, line.item.barcode, line.item.base_unit, line.item.track_inventory,
        line.quantity, line.unitCost, line.lineTotal, currency]);
    }
    await client.query(`INSERT INTO supplier_history_references
      (id, organization_id, supplier_id, reference_type, source_id)
      VALUES ($1, $2, $3, 'PURCHASE', $4)`,
    [randomUUID(), context.organizationId, input.supplierId, input.id]);
    await client.query(`INSERT INTO organization_history_references
      (id, organization_id, reference_domain, reference_type, source_id)
      VALUES ($1, $2, 'MONETARY', 'PURCHASE', $3)`,
    [randomUUID(), context.organizationId, input.id]);
    return { id: input.id, total, currency };
  }
}
