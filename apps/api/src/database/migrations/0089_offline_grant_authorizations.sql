CREATE TABLE offline_grant_authorizations (
  organization_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  proof_hash text NOT NULL CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
  grant_jws text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at = issued_at + interval '72 hours'),
  PRIMARY KEY (organization_id, grant_id),
  FOREIGN KEY (organization_id, grant_id) REFERENCES offline_grants(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, branch_id) REFERENCES branches(organization_id, id) ON DELETE RESTRICT
);
ALTER TABLE offline_grant_authorizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY offline_grant_authorizations_tenant_isolation ON offline_grant_authorizations FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON offline_grant_authorizations TO uco_app;
CREATE TRIGGER offline_grant_authorizations_immutable
  BEFORE UPDATE OR DELETE ON offline_grant_authorizations FOR EACH ROW
  EXECUTE FUNCTION prevent_offline_version_or_resource_mutation();

GRANT UPDATE (expires_at) ON offline_grants TO uco_app;
CREATE FUNCTION guard_offline_grant_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at AND EXISTS (
    SELECT 1 FROM offline_grant_authorizations WHERE organization_id = OLD.organization_id AND grant_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'authorized offline grant deadline is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_offline_grant_deadline() FROM PUBLIC;
CREATE TRIGGER offline_grant_deadline_guard BEFORE UPDATE OF expires_at ON offline_grants FOR EACH ROW
  EXECUTE FUNCTION guard_offline_grant_deadline();
