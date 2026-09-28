CREATE TABLE expenses (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  expense_category_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  concept text NOT NULL CHECK (concept = btrim(concept) AND length(concept) BETWEEN 1 AND 2000),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expenses_tenant_id_key UNIQUE (organization_id, id),
  CONSTRAINT expenses_branch_tenant_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT expenses_category_tenant_fk FOREIGN KEY (organization_id, expense_category_id)
    REFERENCES expense_categories(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT expenses_method_tenant_fk FOREIGN KEY (organization_id, method)
    REFERENCES payment_method_settings(organization_id, method) ON DELETE RESTRICT
);

CREATE FUNCTION prevent_expense_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'confirmed expense history is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER expenses_immutable BEFORE UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION prevent_expense_mutation();
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY expenses_tenant_isolation ON expenses FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON expenses TO uco_app;
