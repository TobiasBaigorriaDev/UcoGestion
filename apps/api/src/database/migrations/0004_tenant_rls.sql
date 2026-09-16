GRANT USAGE ON SCHEMA public TO uco_app;
GRANT SELECT ON TABLE branches, cash_registers TO uco_app;

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_registers ENABLE ROW LEVEL SECURITY;

CREATE POLICY branches_tenant_isolation ON branches
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY cash_registers_tenant_isolation ON cash_registers
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
