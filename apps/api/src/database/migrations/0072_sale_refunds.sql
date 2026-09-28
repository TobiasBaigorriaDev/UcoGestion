ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_tenant_sale_id_unique
  UNIQUE (organization_id, sale_id, id);
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_historical_refund_identity_unique
  UNIQUE (organization_id, sale_id, id, method, applied_amount, currency_code);
ALTER TABLE sale_cancellations ADD CONSTRAINT sale_cancellations_tenant_sale_id_unique
  UNIQUE (organization_id, sale_id, id);

CREATE TABLE sale_refunds (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  cancellation_id uuid NOT NULL,
  sale_payment_id uuid NOT NULL,
  method text NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  refunded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sale_refunds_payment_unique UNIQUE (organization_id, sale_payment_id),
  CONSTRAINT sale_refunds_cancellation_fk FOREIGN KEY (organization_id, sale_id, cancellation_id)
    REFERENCES sale_cancellations (organization_id, sale_id, id) ON DELETE RESTRICT,
  CONSTRAINT sale_refunds_payment_fk FOREIGN KEY
    (organization_id, sale_id, sale_payment_id, method, amount, currency_code)
    REFERENCES sale_payments
    (organization_id, sale_id, id, method, applied_amount, currency_code) ON DELETE RESTRICT
);
CREATE TRIGGER sale_refunds_immutable BEFORE UPDATE OR DELETE ON sale_refunds
  FOR EACH ROW EXECUTE FUNCTION prevent_sale_foundation_mutation();
ALTER TABLE sale_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY sale_refunds_tenant_isolation ON sale_refunds FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON sale_refunds TO uco_app;
