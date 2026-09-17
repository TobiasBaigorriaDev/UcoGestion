ALTER TABLE users ADD COLUMN disabled_at timestamptz;

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_role_check CHECK (role IN ('OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE')),
  CONSTRAINT memberships_organization_id_id_key UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX memberships_active_organization_user_key
  ON memberships (organization_id, user_id) WHERE revoked_at IS NULL;

GRANT SELECT (disabled_at) ON users TO uco_app;
GRANT SELECT ON memberships TO uco_app;

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant_isolation ON memberships
  FOR SELECT TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
