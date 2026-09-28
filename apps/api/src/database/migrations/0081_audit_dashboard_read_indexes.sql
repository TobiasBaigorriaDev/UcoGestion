CREATE INDEX audit_events_tenant_order_idx
  ON audit_events (organization_id, occurred_at DESC, id DESC);

CREATE INDEX audit_events_tenant_branch_order_idx
  ON audit_events (organization_id, branch_id, occurred_at DESC, id DESC);

CREATE INDEX sales_dashboard_scope_idx
  ON sales (organization_id, branch_id, confirmed_at)
  INCLUDE (total, actor_user_id, session_owner_user_id);

CREATE INDEX purchases_dashboard_scope_idx
  ON purchases (organization_id, branch_id, confirmed_at)
  INCLUDE (total);

CREATE INDEX expenses_dashboard_scope_idx
  ON expenses (organization_id, branch_id, occurred_at)
  INCLUDE (amount);

CREATE INDEX cash_sessions_dashboard_scope_idx
  ON cash_sessions (organization_id, branch_id, opened_at)
  INCLUDE (owner_user_id, status, expected_cash);
