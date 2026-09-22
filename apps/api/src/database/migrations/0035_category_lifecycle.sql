ALTER TABLE catalog_categories
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE expense_categories
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE catalog_category_history_references (
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  category_id uuid NOT NULL,
  reference_type text NOT NULL CHECK (length(reference_type) BETWEEN 1 AND 80),
  source_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT catalog_category_history_references_category_tenant_fk
    FOREIGN KEY (organization_id, category_id)
    REFERENCES catalog_categories (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT catalog_category_history_references_source_key
    UNIQUE (organization_id, category_id, reference_type, source_id)
);

CREATE TABLE expense_category_history_references (
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  category_id uuid NOT NULL,
  reference_type text NOT NULL CHECK (length(reference_type) BETWEEN 1 AND 80),
  source_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT expense_category_history_references_category_tenant_fk
    FOREIGN KEY (organization_id, category_id)
    REFERENCES expense_categories (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT expense_category_history_references_source_key
    UNIQUE (organization_id, category_id, reference_type, source_id)
);

ALTER TABLE catalog_category_history_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_category_history_references ENABLE ROW LEVEL SECURITY;

CREATE POLICY catalog_category_history_references_tenant_isolation
  ON catalog_category_history_references
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY expense_category_history_references_tenant_isolation
  ON expense_category_history_references
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, INSERT ON catalog_category_history_references TO uco_app;
GRANT SELECT, INSERT ON expense_category_history_references TO uco_app;

CREATE FUNCTION prevent_category_history_reference_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'category history references are append-only' USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION prevent_category_history_reference_mutation() FROM PUBLIC;

CREATE TRIGGER catalog_category_history_references_immutable
BEFORE UPDATE OR DELETE ON catalog_category_history_references
FOR EACH ROW
EXECUTE FUNCTION prevent_category_history_reference_mutation();

CREATE TRIGGER expense_category_history_references_immutable
BEFORE UPDATE OR DELETE ON expense_category_history_references
FOR EACH ROW
EXECUTE FUNCTION prevent_category_history_reference_mutation();
