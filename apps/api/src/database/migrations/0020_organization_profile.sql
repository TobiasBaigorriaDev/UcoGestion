ALTER TABLE organizations
  ADD COLUMN profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT organizations_profile_object_check CHECK (jsonb_typeof(profile) = 'object');

GRANT SELECT ON organizations TO uco_app;
GRANT UPDATE (profile, version) ON organizations TO uco_app;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant_isolation ON organizations
  FOR ALL TO uco_app
  USING (id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.organization_id', true), '')::uuid);
