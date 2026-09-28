CREATE TABLE object_files (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  storage_key text NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 512),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 128),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'text/csv')),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT object_files_tenant_id_key UNIQUE (organization_id, id),
  CONSTRAINT object_files_expiry_check CHECK (expires_at > created_at)
);

CREATE FUNCTION guard_object_file_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'object file metadata is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER object_file_immutable BEFORE UPDATE OR DELETE ON object_files
  FOR EACH ROW EXECUTE FUNCTION guard_object_file_mutation();

ALTER TABLE object_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY object_files_tenant_isolation ON object_files FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON object_files TO uco_app;
CREATE INDEX object_files_expiry_idx ON object_files (expires_at);
