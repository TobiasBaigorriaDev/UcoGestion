CREATE TABLE catalog_categories (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_categories_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT catalog_categories_name_not_blank_check CHECK (btrim(name) <> ''),
  CONSTRAINT catalog_categories_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT catalog_categories_version_check CHECK (version > 0)
);

ALTER TABLE catalog_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY catalog_categories_tenant_isolation ON catalog_categories
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, INSERT (id, organization_id, name, status, version) ON catalog_categories TO uco_app;
