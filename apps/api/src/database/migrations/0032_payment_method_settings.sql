CREATE TABLE payment_method_settings (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  method text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, method),
  CONSTRAINT payment_method_settings_method_check CHECK (
    method IN ('CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'TRANSFER', 'QR')
  ),
  CONSTRAINT payment_method_settings_version_check CHECK (version > 0)
);

CREATE FUNCTION initialize_payment_method_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO payment_method_settings (organization_id, method)
  VALUES
    (NEW.id, 'CASH'),
    (NEW.id, 'DEBIT_CARD'),
    (NEW.id, 'CREDIT_CARD'),
    (NEW.id, 'TRANSFER'),
    (NEW.id, 'QR');
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_initialize_payment_method_settings
AFTER INSERT ON organizations
FOR EACH ROW
EXECUTE FUNCTION initialize_payment_method_settings();

INSERT INTO payment_method_settings (organization_id, method)
SELECT organizations.id, methods.method
FROM organizations
CROSS JOIN (VALUES ('CASH'), ('DEBIT_CARD'), ('CREDIT_CARD'), ('TRANSFER'), ('QR')) AS methods(method)
ON CONFLICT (organization_id, method) DO NOTHING;

ALTER TABLE payment_method_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_method_settings_tenant_isolation ON payment_method_settings
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, UPDATE (enabled, version) ON payment_method_settings TO uco_app;
