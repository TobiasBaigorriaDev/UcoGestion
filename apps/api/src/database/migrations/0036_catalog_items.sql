CREATE TABLE catalog_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  type text NOT NULL,
  track_inventory boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_items_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT catalog_items_name_not_blank_check CHECK (btrim(name) <> ''),
  CONSTRAINT catalog_items_type_check CHECK (type IN ('PRODUCT', 'SERVICE')),
  CONSTRAINT catalog_items_service_track_inventory_check CHECK (type <> 'SERVICE' OR track_inventory = false),
  CONSTRAINT catalog_items_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT catalog_items_version_check CHECK (version > 0)
);

ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY catalog_items_tenant_isolation ON catalog_items
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, INSERT (id, organization_id, name, type, track_inventory, status, version) ON catalog_items TO uco_app;
