CREATE TABLE membership_revocation_device_knowledge (
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  device_id uuid NOT NULL,
  revoked_at timestamptz NOT NULL,
  known_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, membership_id, device_id),
  CONSTRAINT membership_revocation_knowledge_membership_tenant_fk
    FOREIGN KEY (organization_id, membership_id)
    REFERENCES memberships (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT membership_revocation_knowledge_time_check CHECK (known_at >= revoked_at)
);

ALTER TABLE membership_revocation_device_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY membership_revocation_knowledge_tenant_isolation
  ON membership_revocation_device_knowledge
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, INSERT ON membership_revocation_device_knowledge TO uco_app;
