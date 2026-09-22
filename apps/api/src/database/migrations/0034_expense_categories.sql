CREATE TABLE expense_categories (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_categories_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT expense_categories_name_not_blank_check CHECK (btrim(name) <> ''),
  CONSTRAINT expense_categories_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT expense_categories_version_check CHECK (version > 0)
);

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY expense_categories_tenant_isolation ON expense_categories
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, INSERT (id, organization_id, name, status, version), UPDATE (status, version)
  ON expense_categories TO uco_app;
