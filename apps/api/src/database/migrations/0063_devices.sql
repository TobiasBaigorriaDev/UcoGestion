ALTER TABLE devices
  -- Existing configuration devices have no recorded branch or authorizer yet.
  -- New online devices always supply the complete authorization tuple.
  ADD COLUMN branch_id uuid,
  ADD COLUMN authorized_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN authorized_at timestamptz,
  ADD COLUMN last_seen_at timestamptz,
  ADD COLUMN last_sync_at timestamptz,
  ALTER COLUMN public_key DROP NOT NULL,
  ADD CONSTRAINT devices_organization_branch_id_id_key UNIQUE (organization_id, branch_id, id),
  ADD CONSTRAINT devices_branch_tenant_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT devices_online_authorization_fields_check CHECK (
    (branch_id IS NULL AND authorized_by_user_id IS NULL AND authorized_at IS NULL)
    OR (branch_id IS NOT NULL AND authorized_by_user_id IS NOT NULL AND authorized_at IS NOT NULL)
  );

GRANT INSERT (id, organization_id, branch_id, authorized_by_user_id, authorized_at,
              status, public_key, last_config_version) ON devices TO uco_app;
