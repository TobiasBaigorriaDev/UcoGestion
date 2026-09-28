import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface DashboardQuery {
  readonly branchId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export class DashboardAccessError extends Error {
  constructor(readonly code: 'DASHBOARD_ACCESS_FORBIDDEN' | 'DASHBOARD_BRANCH_FORBIDDEN') {
    super(code === 'DASHBOARD_BRANCH_FORBIDDEN'
      ? 'La sucursal no está asignada.' : 'No tenés acceso a este dashboard.');
  }
}

interface Membership { readonly id: string; readonly role: string }
interface TotalsRow { readonly net: string; readonly count: string; readonly average_ticket: string }

export class DashboardService {
  constructor(private readonly transactions: TenantTransaction) {}

  async get(context: TenantTransactionContext, query: DashboardQuery) {
    return this.transactions.read(context, async (client) => {
      const membership = await this.membership(client, context);
      if (!membership || !['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE'].includes(membership.role)) {
        throw new DashboardAccessError('DASHBOARD_ACCESS_FORBIDDEN');
      }
      const scope = await client.query<{ branch_id: string }>(`SELECT branch_id
        FROM effective_membership_branch_scope WHERE organization_id = $1 AND membership_id = $2`,
      [context.organizationId, membership.id]);
      const branchIds = scope.rows.map((row) => row.branch_id);
      if (query.branchId && !branchIds.includes(query.branchId)) {
        throw new DashboardAccessError('DASHBOARD_BRANCH_FORBIDDEN');
      }
      const selected = query.branchId ? [query.branchId] : branchIds;
      const args = [context.organizationId, selected, query.from ?? null, query.to ?? null];
      if (membership.role === 'CASHIER') {
        return this.cashierDashboard(client, context, selected, args);
      }
      if (membership.role === 'EMPLOYEE') {
        return this.employeeDashboard(client, context, selected);
      }
      const sales = await client.query<TotalsRow>(`SELECT
        coalesce(sum(s.total) FILTER (WHERE sc.id IS NULL), 0)::numeric(20,2)::text AS net,
        count(*) FILTER (WHERE sc.id IS NULL)::text AS count,
        coalesce(round(sum(s.total) FILTER (WHERE sc.id IS NULL) /
          nullif(count(*) FILTER (WHERE sc.id IS NULL), 0), 2), 0)::numeric(20,2)::text AS average_ticket
        FROM sales s LEFT JOIN sale_cancellations sc
          ON sc.organization_id = s.organization_id AND sc.sale_id = s.id
        WHERE s.organization_id = $1 AND s.branch_id = ANY($2::uuid[])
          AND ($3::timestamptz IS NULL OR s.confirmed_at >= $3)
          AND ($4::timestamptz IS NULL OR s.confirmed_at < $4)`, args);
      const expenses = await client.query<{ net: string }>(`SELECT
        coalesce(sum(e.amount) FILTER (WHERE ec.id IS NULL), 0)::numeric(20,2)::text AS net
        FROM expenses e LEFT JOIN expense_cancellations ec
          ON ec.organization_id = e.organization_id AND ec.expense_id = e.id
        WHERE e.organization_id = $1 AND e.branch_id = ANY($2::uuid[])
          AND ($3::timestamptz IS NULL OR e.occurred_at >= $3)
          AND ($4::timestamptz IS NULL OR e.occurred_at < $4)`, args);
      const purchases = await client.query<{ net: string }>(`SELECT
        coalesce(sum(p.total) FILTER (WHERE pc.id IS NULL), 0)::numeric(20,2)::text AS net
        FROM purchases p LEFT JOIN purchase_cancellations pc
          ON pc.organization_id = p.organization_id AND pc.purchase_id = p.id
        WHERE p.organization_id = $1 AND p.branch_id = ANY($2::uuid[])
          AND ($3::timestamptz IS NULL OR p.confirmed_at >= $3)
          AND ($4::timestamptz IS NULL OR p.confirmed_at < $4)`, args);
      const paymentMethods = await client.query<{ method: string; total: string }>(`SELECT sp.method,
        sum(sp.applied_amount)::numeric(20,2)::text AS total
        FROM sale_payments sp JOIN sales s ON s.organization_id = sp.organization_id
          AND s.id = sp.sale_id
        LEFT JOIN sale_cancellations sc ON sc.organization_id = s.organization_id
          AND sc.sale_id = s.id
        WHERE s.organization_id = $1 AND s.branch_id = ANY($2::uuid[]) AND sc.id IS NULL
          AND ($3::timestamptz IS NULL OR s.confirmed_at >= $3)
          AND ($4::timestamptz IS NULL OR s.confirmed_at < $4)
        GROUP BY sp.method ORDER BY sp.method`, args);
      const topItems = await client.query<{ item_id: string; item_name: string;
        quantity: string; total: string }>(`SELECT si.item_id, max(si.item_name) AS item_name,
        sum(si.quantity)::numeric(20,3)::text AS quantity,
        sum(si.line_total)::numeric(20,2)::text AS total
        FROM sale_items si JOIN sales s ON s.organization_id = si.organization_id AND s.id = si.sale_id
        LEFT JOIN sale_cancellations sc ON sc.organization_id = s.organization_id AND sc.sale_id = s.id
        WHERE s.organization_id = $1 AND s.branch_id = ANY($2::uuid[]) AND sc.id IS NULL
          AND ($3::timestamptz IS NULL OR s.confirmed_at >= $3)
          AND ($4::timestamptz IS NULL OR s.confirmed_at < $4)
        GROUP BY si.item_id ORDER BY sum(si.quantity) DESC, si.item_id LIMIT 10`, args);
      const lowStock = await client.query<{ branch_id: string; item_id: string;
        item_name: string; quantity: string; minimum: string }>(`SELECT bs.branch_id, bs.item_id,
        ci.name AS item_name, bs.quantity::text, st.minimum::text
        FROM branch_stocks bs JOIN stock_thresholds st
          ON st.organization_id = bs.organization_id AND st.branch_id = bs.branch_id
          AND st.item_id = bs.item_id
        JOIN catalog_items ci ON ci.organization_id = bs.organization_id AND ci.id = bs.item_id
        WHERE bs.organization_id = $1 AND bs.branch_id = ANY($2::uuid[])
          AND ci.status = 'ACTIVE' AND bs.quantity <= st.minimum
        ORDER BY bs.branch_id, bs.item_id LIMIT 100`, [context.organizationId, selected]);
      const cashSessions = await client.query<{ id: string; branch_id: string; status: string;
        expected_cash: string; owner_user_id: string }>(`SELECT id, branch_id, status,
        expected_cash::text, owner_user_id FROM cash_sessions
        WHERE organization_id = $1 AND branch_id = ANY($2::uuid[])
          AND ($3::timestamptz IS NULL OR opened_at >= $3)
          AND ($4::timestamptz IS NULL OR opened_at < $4)
        ORDER BY opened_at DESC, id DESC LIMIT 100`, args);
      const cashSummary = await client.query<{ branch_id: string; status: string;
        count: string; expected_cash: string }>(`SELECT branch_id, status,
        count(*)::text AS count, sum(expected_cash)::numeric(20,2)::text AS expected_cash
        FROM cash_sessions WHERE organization_id = $1 AND branch_id = ANY($2::uuid[])
          AND ($3::timestamptz IS NULL OR opened_at >= $3)
          AND ($4::timestamptz IS NULL OR opened_at < $4)
        GROUP BY branch_id, status ORDER BY branch_id, status`, args);
      const sale = sales.rows[0];
      const operatingResult = await client.query<{ amount: string }>(`SELECT
        ($1::numeric - $2::numeric)::numeric(20,2)::text AS amount`,
      [sale?.net ?? '0.00', expenses.rows[0]?.net ?? '0.00']);
      return {
        role: membership.role as 'OWNER' | 'ADMIN', branchIds: selected,
        sales: { net: sale?.net ?? '0.00', count: Number(sale?.count ?? '0'),
          averageTicket: sale?.average_ticket ?? '0.00' },
        expenses: { net: expenses.rows[0]?.net ?? '0.00' },
        purchases: { net: purchases.rows[0]?.net ?? '0.00' },
        operatingResult: { amount: operatingResult.rows[0]?.amount ?? '0.00',
          label: 'Resultado operativo' },
        paymentMethods: paymentMethods.rows.map((row) => ({ method: row.method, total: row.total })),
        topItems: topItems.rows.map((row) => ({ itemId: row.item_id, name: row.item_name,
          quantity: row.quantity, total: row.total })),
        lowStock: lowStock.rows.map((row) => ({ branchId: row.branch_id, itemId: row.item_id,
          name: row.item_name, quantity: row.quantity, minimum: row.minimum })),
        cashSessions: cashSessions.rows.map((row) => ({ id: row.id, branchId: row.branch_id,
          status: row.status, expectedCash: row.expected_cash, ownerUserId: row.owner_user_id })),
        cashSummary: cashSummary.rows.map((row) => ({ branchId: row.branch_id,
          status: row.status, count: Number(row.count), expectedCash: row.expected_cash })),
      };
    });
  }

  private async cashierDashboard(client: PoolClient, context: TenantTransactionContext,
    branchIds: string[], args: (string | string[] | null)[]) {
    const sales = await client.query<TotalsRow>(`SELECT
      coalesce(sum(s.total) FILTER (WHERE sc.id IS NULL), 0)::numeric(20,2)::text AS net,
      count(*) FILTER (WHERE sc.id IS NULL)::text AS count,
      coalesce(round(sum(s.total) FILTER (WHERE sc.id IS NULL) /
        nullif(count(*) FILTER (WHERE sc.id IS NULL), 0), 2), 0)::numeric(20,2)::text AS average_ticket
      FROM sales s LEFT JOIN sale_cancellations sc ON sc.organization_id = s.organization_id
        AND sc.sale_id = s.id
      WHERE s.organization_id = $1 AND s.branch_id = ANY($2::uuid[])
        AND s.actor_user_id = $5 AND s.session_owner_user_id = $5
        AND ($3::timestamptz IS NULL OR s.confirmed_at >= $3)
        AND ($4::timestamptz IS NULL OR s.confirmed_at < $4)`, [...args, context.userId]);
    const sessions = await client.query<{ id: string; branch_id: string; status: string;
      expected_cash: string }>(`SELECT id, branch_id, status, expected_cash::text
      FROM cash_sessions WHERE organization_id = $1 AND branch_id = ANY($2::uuid[])
        AND owner_user_id = $5
        AND ($3::timestamptz IS NULL OR opened_at >= $3)
        AND ($4::timestamptz IS NULL OR opened_at < $4)
      ORDER BY opened_at DESC, id DESC LIMIT 100`, [...args, context.userId]);
    const sale = sales.rows[0];
    return { role: 'CASHIER' as const, branchIds,
      sales: { net: sale?.net ?? '0.00', count: Number(sale?.count ?? '0'),
        averageTicket: sale?.average_ticket ?? '0.00' },
      cashSessions: sessions.rows.map((row) => ({ id: row.id, branchId: row.branch_id,
        status: row.status, expectedCash: row.expected_cash })) };
  }

  private async employeeDashboard(client: PoolClient, context: TenantTransactionContext,
    branchIds: string[]) {
    const catalog = await client.query<{ id: string; name: string; type: string;
      status: string }>(`SELECT id, name, type, status FROM catalog_items
      WHERE organization_id = $1 AND status = 'ACTIVE' ORDER BY name, id LIMIT 100`,
    [context.organizationId]);
    const inventory = await client.query<{ branch_id: string; item_id: string;
      quantity: string }>(`SELECT branch_id, item_id, quantity::text FROM branch_stocks
      WHERE organization_id = $1 AND branch_id = ANY($2::uuid[])
      ORDER BY branch_id, item_id LIMIT 100`, [context.organizationId, branchIds]);
    return { role: 'EMPLOYEE' as const, branchIds,
      catalog: catalog.rows.map((row) => ({ itemId: row.id, name: row.name, type: row.type,
        status: row.status })),
      inventory: inventory.rows.map((row) => ({ branchId: row.branch_id,
        itemId: row.item_id, quantity: row.quantity })) };
  }

  private async membership(client: PoolClient, context: TenantTransactionContext) {
    const result = await client.query<Membership>(`SELECT id, role FROM memberships
      WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'
        AND revoked_at IS NULL`,
    [context.organizationId, context.userId]);
    return result.rows.at(0) ?? null;
  }
}
