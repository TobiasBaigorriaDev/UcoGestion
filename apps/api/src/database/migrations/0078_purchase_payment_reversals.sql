ALTER TABLE purchase_payments ADD CONSTRAINT purchase_payments_historical_reversal_key
  UNIQUE (organization_id, purchase_id, id, method, amount, currency_code);

CREATE TABLE purchase_payment_reversals (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  purchase_id uuid NOT NULL,
  cancellation_id uuid NOT NULL,
  purchase_payment_id uuid NOT NULL,
  method text NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  reversed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_payment_reversals_payment_unique UNIQUE (organization_id, purchase_payment_id),
  CONSTRAINT purchase_payment_reversals_cancellation_fk FOREIGN KEY
    (organization_id, purchase_id, cancellation_id)
    REFERENCES purchase_cancellations (organization_id, purchase_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchase_payment_reversals_payment_fk FOREIGN KEY
    (organization_id, purchase_id, purchase_payment_id, method, amount, currency_code)
    REFERENCES purchase_payments
    (organization_id, purchase_id, id, method, amount, currency_code) ON DELETE RESTRICT
);
CREATE TRIGGER purchase_payment_reversals_immutable BEFORE UPDATE OR DELETE ON purchase_payment_reversals
  FOR EACH ROW EXECUTE FUNCTION prevent_purchase_foundation_mutation();
ALTER TABLE purchase_payment_reversals ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_payment_reversals_tenant_isolation ON purchase_payment_reversals FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON purchase_payment_reversals TO uco_app;
