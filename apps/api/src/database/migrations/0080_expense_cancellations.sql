ALTER TABLE expenses ADD CONSTRAINT expenses_tenant_branch_id_key
  UNIQUE (organization_id, branch_id, id);
ALTER TABLE expenses ADD CONSTRAINT expenses_cancellation_snapshot_key
  UNIQUE (organization_id, branch_id, id, method, amount, currency_code);

CREATE TABLE expense_cancellations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  method text NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  effect_kind text NOT NULL CHECK
    ((method = 'CASH' AND effect_kind = 'CASH_RETURN') OR
     (method <> 'CASH' AND effect_kind = 'NONCASH_REVERSAL')),
  cancelled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_cancellations_expense_unique UNIQUE (organization_id, expense_id),
  CONSTRAINT expense_cancellations_expense_fk FOREIGN KEY
    (organization_id, branch_id, expense_id, method, amount, currency_code)
    REFERENCES expenses (organization_id, branch_id, id, method, amount, currency_code) ON DELETE RESTRICT,
  CONSTRAINT expense_cancellations_method_fk FOREIGN KEY (organization_id, method)
    REFERENCES payment_method_settings (organization_id, method) ON DELETE RESTRICT
);
CREATE TRIGGER expense_cancellations_immutable BEFORE UPDATE OR DELETE ON expense_cancellations
  FOR EACH ROW EXECUTE FUNCTION prevent_expense_mutation();
ALTER TABLE expense_cancellations ENABLE ROW LEVEL SECURITY;
CREATE POLICY expense_cancellations_tenant_isolation ON expense_cancellations FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON expense_cancellations TO uco_app;
