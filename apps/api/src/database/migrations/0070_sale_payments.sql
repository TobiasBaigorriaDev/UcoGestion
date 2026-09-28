CREATE TABLE sale_payments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  method text NOT NULL,
  applied_amount numeric(20,2) NOT NULL CHECK (applied_amount > 0),
  received_amount numeric(20,2),
  change_amount numeric(20,2) NOT NULL DEFAULT 0 CHECK (change_amount >= 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT sale_payments_sale_fk FOREIGN KEY (organization_id, sale_id)
    REFERENCES sales (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT sale_payments_method_fk FOREIGN KEY (organization_id, method)
    REFERENCES payment_method_settings (organization_id, method) ON DELETE RESTRICT,
  CONSTRAINT sale_payments_cash_received_check CHECK (
    (method = 'CASH' AND received_amount IS NOT NULL AND received_amount = applied_amount + change_amount)
    OR (method <> 'CASH' AND received_amount IS NULL AND change_amount = 0)
  )
);
CREATE FUNCTION prevent_sale_payment_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sale payments are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER sale_payments_immutable BEFORE UPDATE OR DELETE ON sale_payments
  FOR EACH ROW EXECUTE FUNCTION prevent_sale_payment_mutation();
ALTER TABLE sale_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY sale_payments_tenant_isolation ON sale_payments FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON sale_payments TO uco_app;
