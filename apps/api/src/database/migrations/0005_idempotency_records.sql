CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (length(scope) > 0),
  key text NOT NULL CHECK (length(key) > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_code integer,
  response_body jsonb,
  resource_id uuid,
  actor_user_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  authorization_class text NOT NULL CHECK (length(authorization_class) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT idempotency_records_organization_scope_key_key UNIQUE (organization_id, scope, key),
  CONSTRAINT idempotency_records_branch_organization_fkey
    FOREIGN KEY (organization_id, branch_id) REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT idempotency_records_completion_check CHECK (
    (status = 'IN_PROGRESS' AND response_code IS NULL AND response_body IS NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND response_code IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);

GRANT SELECT, INSERT, UPDATE ON TABLE idempotency_records TO uco_app;

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY idempotency_records_tenant_isolation ON idempotency_records
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
