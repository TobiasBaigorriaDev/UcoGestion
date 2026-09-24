-- Expense categories are never included in the offline POS configuration. Their
-- server history references remain protected by RESTRICT and the append-only ledger.
GRANT DELETE, UPDATE (updated_at) ON expense_categories TO uco_app;
