CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  branch_id uuid,
  device_id uuid,
  request_id text NOT NULL CHECK (length(request_id) > 0),
  operation_id text NOT NULL CHECK (length(operation_id) > 0),
  entity_type text NOT NULL CHECK (length(entity_type) > 0),
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (length(action) > 0),
  before_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(before_data) = 'object'),
  after_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(after_data) = 'object'),
  context_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context_data) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_branch_organization_fkey
    FOREIGN KEY (organization_id, branch_id) REFERENCES branches(organization_id, id) ON DELETE RESTRICT
);

GRANT SELECT, INSERT ON TABLE audit_events TO uco_app;

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_events_tenant_isolation ON audit_events
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE FUNCTION prevent_audit_events_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_events_mutation();
