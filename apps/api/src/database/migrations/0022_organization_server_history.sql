ALTER TABLE organizations
  ADD COLUMN operational_history_started_at timestamptz;

CREATE TABLE organization_history_references (
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  reference_domain text NOT NULL CHECK (reference_domain IN ('COMMERCIAL', 'MONETARY', 'INVENTORY')),
  reference_type text NOT NULL CHECK (length(reference_type) BETWEEN 1 AND 80),
  source_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT organization_history_references_organization_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT organization_history_references_source_key
    UNIQUE (organization_id, reference_domain, reference_type, source_id)
);

ALTER TABLE organization_history_references ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_history_references_tenant_isolation ON organization_history_references
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, INSERT ON organization_history_references TO uco_app;

CREATE FUNCTION mark_organization_operational_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.organizations
  SET operational_history_started_at = COALESCE(operational_history_started_at, NEW.recorded_at)
  WHERE id = NEW.organization_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION mark_organization_operational_history() FROM PUBLIC;

CREATE TRIGGER organization_history_references_mark_history
AFTER INSERT ON organization_history_references
FOR EACH ROW
EXECUTE FUNCTION mark_organization_operational_history();

CREATE FUNCTION prevent_organization_history_reference_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'organization_history_references are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER organization_history_references_immutable
BEFORE UPDATE OR DELETE ON organization_history_references
FOR EACH ROW
EXECUTE FUNCTION prevent_organization_history_reference_mutation();
