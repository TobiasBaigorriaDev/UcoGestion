CREATE TABLE report_exports (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  dataset text NOT NULL CHECK (dataset IN ('sales', 'inventory', 'inventory-movements',
    'cash', 'purchases', 'expenses')),
  format text NOT NULL CHECK (format = 'PDF'),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters) = 'object'),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN
    ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED')),
  file_id uuid,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_exports_tenant_id_key UNIQUE (organization_id, id),
  CONSTRAINT report_exports_file_fk FOREIGN KEY (organization_id, file_id)
    REFERENCES object_files(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_exports_ready_file_check CHECK
    ((status IN ('READY', 'EXPIRED')) = (file_id IS NOT NULL))
);

CREATE FUNCTION guard_report_export_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'status' - 'file_id' - 'error_code' - 'updated_at') <>
      (to_jsonb(OLD) - 'status' - 'file_id' - 'error_code' - 'updated_at') OR
     NOT ((OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING', 'FAILED')) OR
          (OLD.status = 'RUNNING' AND NEW.status IN ('RUNNING', 'READY', 'FAILED')) OR
          (OLD.status = 'READY' AND NEW.status = 'EXPIRED')) THEN
    RAISE EXCEPTION 'invalid report export mutation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER report_export_update_guard BEFORE UPDATE OR DELETE ON report_exports
  FOR EACH ROW EXECUTE FUNCTION guard_report_export_update();

ALTER TABLE report_exports ENABLE ROW LEVEL SECURITY;
CREATE POLICY report_exports_tenant_isolation ON report_exports FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE (status, file_id, error_code, updated_at) ON report_exports TO uco_app;
CREATE INDEX report_exports_actor_idx ON report_exports
  (organization_id, actor_user_id, created_at DESC);
