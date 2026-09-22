CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  email_normalized text NOT NULL,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  invited_by_membership_id uuid NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT invitations_inviter_tenant_fk
    FOREIGN KEY (organization_id, invited_by_membership_id)
    REFERENCES memberships (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT invitations_email_normalized_check CHECK (
    email_normalized <> '' AND email_normalized = lower(btrim(email_normalized))
  ),
  CONSTRAINT invitations_role_check CHECK (role IN ('OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE')),
  CONSTRAINT invitations_status_check CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')),
  CONSTRAINT invitations_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invitations_expiration_check CHECK (expires_at > created_at)
);

CREATE TABLE invitation_branches (
  organization_id uuid NOT NULL,
  invitation_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, invitation_id, branch_id),
  CONSTRAINT invitation_branches_invitation_tenant_fk
    FOREIGN KEY (organization_id, invitation_id)
    REFERENCES invitations (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT invitation_branches_branch_tenant_fk
    FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id)
    ON DELETE RESTRICT
);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation_branches ENABLE ROW LEVEL SECURITY;

CREATE POLICY invitations_tenant_isolation ON invitations
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY invitation_branches_tenant_isolation ON invitation_branches
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, INSERT ON invitations, invitation_branches TO uco_app;
