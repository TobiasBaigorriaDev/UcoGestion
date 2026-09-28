CREATE TABLE purchase_payments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  purchase_id uuid NOT NULL,
  method text NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  paid_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_payments_one_per_purchase UNIQUE (organization_id, purchase_id),
  CONSTRAINT purchase_payments_purchase_tenant_fk FOREIGN KEY (organization_id, purchase_id)
    REFERENCES purchases(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchase_payments_method_tenant_fk FOREIGN KEY (organization_id, method)
    REFERENCES payment_method_settings(organization_id, method) ON DELETE RESTRICT
);
CREATE TRIGGER purchase_payments_immutable BEFORE UPDATE OR DELETE ON purchase_payments
  FOR EACH ROW EXECUTE FUNCTION prevent_purchase_foundation_mutation();
ALTER TABLE purchase_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_payments_tenant_isolation ON purchase_payments FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON purchase_payments TO uco_app;
-- Row locks on the immutable purchase header require UPDATE privilege; its mutation trigger still rejects writes.
GRANT UPDATE ON purchases TO uco_app;
