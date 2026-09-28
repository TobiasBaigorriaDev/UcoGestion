import type { PoolClient } from 'pg';

import { encodeCursor, type Cursor } from '../../core/validation/pagination.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export type ReportDataset = 'sales' | 'inventory' | 'inventory-movements' | 'cash' |
  'purchases' | 'expenses';

export interface ReportQuery {
  readonly limit: number;
  readonly cursor?: Cursor | undefined;
  readonly branchId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly status?: string | undefined;
  readonly lowStock?: boolean | undefined;
}

export interface ReportItem {
  readonly id: string;
  readonly itemId?: string;
  readonly branchId: string;
  readonly [key: string]: unknown;
}

export interface ReportResult {
  readonly dataset: ReportDataset;
  readonly items: ReportItem[];
  readonly nextCursor: string | null;
  readonly net?: string;
}

export class ReportAccessError extends Error {
  constructor(readonly code: 'REPORT_ACCESS_FORBIDDEN' | 'REPORT_BRANCH_FORBIDDEN') {
    super(code === 'REPORT_BRANCH_FORBIDDEN' ? 'La sucursal no está asignada.' :
      'No tenés acceso a este reporte.');
  }
}

interface ReportRow {
  readonly id: string;
  readonly branch_id: string;
  readonly occurred_at: Date;
  readonly status: string;
  readonly total: string;
  readonly currency_code: string;
  readonly actor_user_id: string;
  readonly cash_session_id: string;
  readonly occurred_cursor: string;
}

export class ReportsService {
  constructor(private readonly transactions: TenantTransaction) {}

  async list(context: TenantTransactionContext, dataset: ReportDataset,
    query: ReportQuery): Promise<ReportResult> {
    return this.transactions.read(context, async (client) => {
      const { role, branches } = await this.authorize(client, context, dataset, query);
      if (dataset === 'sales') return this.sales(client, context, role, branches, query);
      if (dataset === 'inventory') return this.inventory(client, context, branches, query);
      if (dataset === 'inventory-movements') {
        return this.inventoryMovements(client, context, branches, query);
      }
      if (dataset === 'cash') return this.cash(client, context, role, branches, query);
      if (dataset === 'purchases') return this.purchases(client, context, branches, query);
      if (dataset === 'expenses') return this.expenses(client, context, branches, query);
      throw new Error(`Unsupported report dataset: ${dataset}`);
    });
  }

  async authorize(client: PoolClient, context: TenantTransactionContext,
    dataset: ReportDataset, query: ReportQuery): Promise<{ role: string; branches: string[] }> {
      const membership = await client.query<{ id: string; role: string }>(`SELECT id, role
        FROM memberships WHERE organization_id = $1 AND user_id = $2
          AND status = 'ACTIVE' AND revoked_at IS NULL`,
      [context.organizationId, context.userId]);
      const member = membership.rows[0];
      const permittedRoles = dataset === 'sales' || dataset === 'cash'
        ? ['OWNER', 'ADMIN', 'CASHIER']
        : dataset === 'inventory' || dataset === 'inventory-movements'
          ? ['OWNER', 'ADMIN', 'EMPLOYEE'] : ['OWNER', 'ADMIN'];
      if (!member || !permittedRoles.includes(member.role)) {
        throw new ReportAccessError('REPORT_ACCESS_FORBIDDEN');
      }
      const scope = await client.query<{ branch_id: string }>(`SELECT branch_id
        FROM effective_membership_branch_scope WHERE organization_id = $1 AND membership_id = $2`,
      [context.organizationId, member.id]);
      const branchIds = scope.rows.map((row) => row.branch_id);
      if (query.branchId && !branchIds.includes(query.branchId)) {
        throw new ReportAccessError('REPORT_BRANCH_FORBIDDEN');
      }
      const selected = query.branchId ? [query.branchId] : branchIds;
      return { role: member.role, branches: selected };
  }

  private async expenses(client: PoolClient, context: TenantTransactionContext,
    branches: string[], query: ReportQuery): Promise<ReportResult> {
    const args = [context.organizationId, branches, query.from ?? null, query.to ?? null,
      query.status ?? null];
    const joins = `FROM expenses e JOIN organizations o ON o.id = e.organization_id
      LEFT JOIN expense_cancellations ec ON ec.organization_id = e.organization_id
        AND ec.expense_id = e.id`;
    const predicate = `e.organization_id = $1 AND e.branch_id = ANY($2::uuid[])
      AND ($3::date IS NULL OR e.occurred_at >= ($3::date::timestamp AT TIME ZONE o.timezone))
      AND ($4::date IS NULL OR e.occurred_at < ($4::date::timestamp AT TIME ZONE o.timezone))
      AND ($5::text IS NULL OR
        (CASE WHEN ec.id IS NULL THEN 'CONFIRMED' ELSE 'CANCELLED' END) = $5)`;
    const totals = await client.query<{ net: string }>(`SELECT
      coalesce(sum(e.amount) FILTER (WHERE ec.id IS NULL),0)::numeric(20,2)::text AS net
      ${joins} WHERE ${predicate}`, args);
    const rows = await client.query<{ id: string; branch_id: string;
      expense_category_id: string; actor_user_id: string; concept: string; amount: string;
      method: string; currency_code: string; status: string; occurred_at: Date;
      occurred_cursor: string }>(`SELECT
      e.id, e.branch_id, e.expense_category_id, e.actor_user_id, e.concept,
      e.amount::text, e.method, e.currency_code,
      CASE WHEN ec.id IS NULL THEN 'CONFIRMED' ELSE 'CANCELLED' END AS status,
      e.occurred_at,
      to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        AS occurred_cursor ${joins} WHERE ${predicate}
        AND ($6::timestamptz IS NULL OR (e.occurred_at, e.id) < ($6::timestamptz, $7::uuid))
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT $8`,
    [...args, query.cursor?.sortValue ?? null, query.cursor?.id ?? null, query.limit + 1]);
    const page = rows.rows.slice(0, query.limit);
    const last = page.at(-1);
    return { dataset: 'expenses', net: totals.rows[0]?.net ?? '0.00',
      items: page.map((row) => ({ id: row.id, branchId: row.branch_id,
        categoryId: row.expense_category_id, actorUserId: row.actor_user_id,
        concept: row.concept, amount: row.amount, method: row.method,
        currencyCode: row.currency_code, status: row.status,
        occurredAt: row.occurred_at.toISOString() })),
      nextCursor: rows.rows.length > query.limit && last
        ? encodeCursor({ id: last.id, sortValue: last.occurred_cursor }) : null };
  }

  private async purchases(client: PoolClient, context: TenantTransactionContext,
    branches: string[], query: ReportQuery): Promise<ReportResult> {
    const args = [context.organizationId, branches, query.from ?? null, query.to ?? null,
      query.status ?? null];
    const state = `CASE WHEN pc.id IS NOT NULL THEN 'CANCELLED'
      WHEN pp.id IS NOT NULL THEN 'PAID' ELSE 'PENDING_PAYMENT' END`;
    const predicate = `p.organization_id = $1 AND p.branch_id = ANY($2::uuid[])
      AND ($3::date IS NULL OR p.confirmed_at >= ($3::date::timestamp AT TIME ZONE o.timezone))
      AND ($4::date IS NULL OR p.confirmed_at < ($4::date::timestamp AT TIME ZONE o.timezone))
      AND ($5::text IS NULL OR ${state} = $5)`;
    const joins = `FROM purchases p JOIN organizations o ON o.id = p.organization_id
      LEFT JOIN purchase_payments pp ON pp.organization_id = p.organization_id
        AND pp.purchase_id = p.id
      LEFT JOIN purchase_cancellations pc ON pc.organization_id = p.organization_id
        AND pc.purchase_id = p.id`;
    const totals = await client.query<{ net: string }>(`SELECT
      coalesce(sum(p.total) FILTER (WHERE pc.id IS NULL),0)::numeric(20,2)::text AS net
      ${joins} WHERE ${predicate}`, args);
    const rows = await client.query<{ id: string; branch_id: string; supplier_id: string;
      actor_user_id: string; status: string; total: string; currency_code: string;
      confirmed_at: Date; occurred_cursor: string }>(`SELECT p.id, p.branch_id,
      p.supplier_id, p.actor_user_id, ${state} AS status, p.total::text,
      p.currency_code, p.confirmed_at,
      to_char(p.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        AS occurred_cursor
      ${joins} WHERE ${predicate}
        AND ($6::timestamptz IS NULL OR (p.confirmed_at, p.id) < ($6::timestamptz, $7::uuid))
      ORDER BY p.confirmed_at DESC, p.id DESC LIMIT $8`,
    [...args, query.cursor?.sortValue ?? null, query.cursor?.id ?? null, query.limit + 1]);
    const page = rows.rows.slice(0, query.limit);
    const last = page.at(-1);
    return { dataset: 'purchases', net: totals.rows[0]?.net ?? '0.00',
      items: page.map((row) => ({ id: row.id, branchId: row.branch_id,
        supplierId: row.supplier_id, actorUserId: row.actor_user_id,
        status: row.status, total: row.total, currencyCode: row.currency_code,
        occurredAt: row.confirmed_at.toISOString() })),
      nextCursor: rows.rows.length > query.limit && last
        ? encodeCursor({ id: last.id, sortValue: last.occurred_cursor }) : null };
  }

  private async cash(client: PoolClient, context: TenantTransactionContext, role: string,
    branches: string[], query: ReportQuery): Promise<ReportResult> {
    const rows = await client.query<{ id: string; branch_id: string; cash_register_id: string;
      owner_user_id: string; status: string; origin: string; opening_cash: string;
      expected_cash: string; currency_code: string; opened_at: Date; movement_total: string;
      movement_count: string; counted_cash: string | null; difference: string | null;
      occurred_cursor: string }>(`SELECT s.id, s.branch_id,
      s.cash_register_id, s.owner_user_id,
      s.status, s.origin, s.opening_cash::text, s.expected_cash::text, s.currency_code,
      c.counted_cash::text, c.difference::text,
      s.opened_at,
      to_char(s.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        AS occurred_cursor,
      coalesce(sum(m.delta),0)::numeric(20,2)::text AS movement_total,
      count(m.id)::text AS movement_count
      FROM cash_sessions s JOIN organizations o ON o.id = s.organization_id
      LEFT JOIN cash_session_closures c ON c.organization_id = s.organization_id
        AND c.cash_session_id = s.id
      LEFT JOIN cash_movements m ON m.organization_id = s.organization_id
        AND m.cash_session_id = s.id
      WHERE s.organization_id = $1 AND s.branch_id = ANY($2::uuid[])
        AND ($3::date IS NULL OR s.opened_at >= ($3::date::timestamp AT TIME ZONE o.timezone))
        AND ($4::date IS NULL OR s.opened_at < ($4::date::timestamp AT TIME ZONE o.timezone))
        AND ($5::uuid IS NULL OR s.owner_user_id = $5)
        AND ($6::text IS NULL OR s.status = $6)
        AND ($7::timestamptz IS NULL OR (s.opened_at, s.id) < ($7::timestamptz, $8::uuid))
      GROUP BY s.id, s.branch_id, s.cash_register_id, s.owner_user_id,
        s.status, s.origin, s.opening_cash, s.expected_cash, s.currency_code, s.opened_at,
        c.counted_cash, c.difference
      ORDER BY s.opened_at DESC, s.id DESC LIMIT $9`,
    [context.organizationId, branches, query.from ?? null, query.to ?? null,
      role === 'CASHIER' ? context.userId : null, query.status ?? null,
      query.cursor?.sortValue ?? null, query.cursor?.id ?? null, query.limit + 1]);
    const page = rows.rows.slice(0, query.limit);
    const last = page.at(-1);
    return { dataset: 'cash', items: page.map((row) => ({ id: row.id,
      branchId: row.branch_id, cashRegisterId: row.cash_register_id,
      ownerUserId: row.owner_user_id, status: row.status, origin: row.origin,
      openingCash: row.opening_cash, expectedCash: row.expected_cash,
      movementTotal: row.movement_total, movementCount: Number(row.movement_count),
      currencyCode: row.currency_code, openedAt: row.opened_at.toISOString(),
      countedCash: row.counted_cash, difference: row.difference })),
      nextCursor: rows.rows.length > query.limit && last
        ? encodeCursor({ id: last.id, sortValue: last.occurred_cursor }) : null };
  }

  private async inventoryMovements(client: PoolClient, context: TenantTransactionContext,
    branches: string[], query: ReportQuery): Promise<ReportResult> {
    const rows = await client.query<{ id: string; branch_id: string; item_id: string;
      item_name: string; actor_user_id: string; delta: string; source_type: string;
      source_id: string; effect_kind: string; occurred_at: Date;
      occurred_cursor: string }>(`SELECT m.id, m.branch_id,
      m.item_id, ci.name AS item_name, m.actor_user_id, m.delta::text, m.source_type,
      m.source_id, m.effect_kind, m.occurred_at,
      to_char(m.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        AS occurred_cursor
      FROM inventory_movements m JOIN organizations o ON o.id = m.organization_id
      JOIN catalog_items ci ON ci.organization_id = m.organization_id AND ci.id = m.item_id
      WHERE m.organization_id = $1 AND m.branch_id = ANY($2::uuid[])
        AND ($3::date IS NULL OR m.occurred_at >= ($3::date::timestamp AT TIME ZONE o.timezone))
        AND ($4::date IS NULL OR m.occurred_at < ($4::date::timestamp AT TIME ZONE o.timezone))
        AND ($5::timestamptz IS NULL OR (m.occurred_at, m.id) < ($5::timestamptz, $6::uuid))
      ORDER BY m.occurred_at DESC, m.id DESC LIMIT $7`,
    [context.organizationId, branches, query.from ?? null, query.to ?? null,
      query.cursor?.sortValue ?? null, query.cursor?.id ?? null, query.limit + 1]);
    const page = rows.rows.slice(0, query.limit);
    const last = page.at(-1);
    return { dataset: 'inventory-movements', items: page.map((row) => ({ id: row.id,
      branchId: row.branch_id, itemId: row.item_id, itemName: row.item_name,
      actorUserId: row.actor_user_id, delta: row.delta, sourceType: row.source_type,
      sourceId: row.source_id, effectKind: row.effect_kind,
      occurredAt: row.occurred_at.toISOString() })),
      nextCursor: rows.rows.length > query.limit && last
        ? encodeCursor({ id: last.id, sortValue: last.occurred_cursor }) : null };
  }

  private async inventory(client: PoolClient, context: TenantTransactionContext,
    branches: string[], query: ReportQuery): Promise<ReportResult> {
    const rows = await client.query<{ branch_id: string; item_id: string; name: string;
      quantity: string; minimum: string | null; low_stock: boolean }>(`SELECT bs.branch_id,
      bs.item_id, ci.name, bs.quantity::text, st.minimum::text,
      (st.minimum IS NOT NULL AND bs.quantity <= st.minimum) AS low_stock
      FROM branch_stocks bs JOIN catalog_items ci
        ON ci.organization_id = bs.organization_id AND ci.id = bs.item_id
      LEFT JOIN stock_thresholds st ON st.organization_id = bs.organization_id
        AND st.branch_id = bs.branch_id AND st.item_id = bs.item_id
      WHERE bs.organization_id = $1 AND bs.branch_id = ANY($2::uuid[])
        AND ($3::boolean IS NULL OR
          (st.minimum IS NOT NULL AND bs.quantity <= st.minimum) = $3)
        AND ($4::uuid IS NULL OR (bs.branch_id, bs.item_id) > ($4::uuid, $5::uuid))
      ORDER BY bs.branch_id, bs.item_id LIMIT $6`,
    [context.organizationId, branches, query.lowStock ?? null,
      query.cursor?.sortValue ?? null, query.cursor?.id ?? null, query.limit + 1]);
    const page = rows.rows.slice(0, query.limit);
    const last = page.at(-1);
    return { dataset: 'inventory', items: page.map((row) => ({ id: row.item_id,
      branchId: row.branch_id, itemId: row.item_id, name: row.name, quantity: row.quantity,
      minimum: row.minimum, lowStock: row.low_stock })),
      nextCursor: rows.rows.length > query.limit && last
        ? encodeCursor({ id: last.item_id, sortValue: last.branch_id }) : null };
  }

  private async sales(client: PoolClient, context: TenantTransactionContext, role: string,
    branches: string[], query: ReportQuery) {
    const args = [context.organizationId, branches, query.from ?? null, query.to ?? null,
      role === 'CASHIER' ? context.userId : null, query.status ?? null];
    const predicate = `s.organization_id = $1 AND s.branch_id = ANY($2::uuid[])
      AND ($3::date IS NULL OR s.confirmed_at >= ($3::date::timestamp AT TIME ZONE o.timezone))
      AND ($4::date IS NULL OR s.confirmed_at < ($4::date::timestamp AT TIME ZONE o.timezone))
      AND ($5::uuid IS NULL OR s.actor_user_id = $5)
      AND ($6::text IS NULL OR (CASE WHEN sc.id IS NULL THEN 'CONFIRMED' ELSE 'CANCELLED' END) = $6)`;
    const totals = await client.query<{ net: string }>(`SELECT
      coalesce(sum(s.total) FILTER (WHERE sc.id IS NULL),0)::numeric(20,2)::text AS net
      FROM sales s JOIN organizations o ON o.id = s.organization_id
      LEFT JOIN sale_cancellations sc ON sc.organization_id = s.organization_id AND sc.sale_id = s.id
      WHERE ${predicate}`, args);
    const rows = await client.query<ReportRow>(`SELECT s.id, s.branch_id, s.confirmed_at AS occurred_at,
      CASE WHEN sc.id IS NULL THEN 'CONFIRMED' ELSE 'CANCELLED' END AS status,
      s.total::text, s.currency_code, s.actor_user_id, s.cash_session_id,
      to_char(s.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        AS occurred_cursor
      FROM sales s JOIN organizations o ON o.id = s.organization_id
      LEFT JOIN sale_cancellations sc ON sc.organization_id = s.organization_id AND sc.sale_id = s.id
      WHERE ${predicate}
        AND ($7::timestamptz IS NULL OR (s.confirmed_at, s.id) < ($7::timestamptz, $8::uuid))
      ORDER BY s.confirmed_at DESC, s.id DESC LIMIT $9`,
    [...args, query.cursor?.sortValue ?? null, query.cursor?.id ?? null, query.limit + 1]);
    const page = rows.rows.slice(0, query.limit);
    const last = page.at(-1);
    return { dataset: 'sales' as const, net: totals.rows[0]?.net ?? '0.00',
      items: page.map((row) => ({ id: row.id, branchId: row.branch_id,
        occurredAt: row.occurred_at.toISOString(), status: row.status, total: row.total,
        currencyCode: row.currency_code, actorUserId: row.actor_user_id,
        cashSessionId: row.cash_session_id })),
      nextCursor: rows.rows.length > query.limit && last
        ? encodeCursor({ id: last.id, sortValue: last.occurred_cursor }) : null };
  }
}
