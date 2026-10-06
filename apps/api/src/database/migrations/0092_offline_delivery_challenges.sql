ALTER TABLE security_rate_limits DROP CONSTRAINT security_rate_limits_scope_check;
ALTER TABLE security_rate_limits ADD CONSTRAINT security_rate_limits_scope_check
  CHECK (scope IN ('LOGIN','PASSWORD_RESET','INVITATION','OFFLINE_DELIVERY'));

CREATE TABLE sync_delivery_challenges (
  organization_id uuid NOT NULL,
  device_id uuid NOT NULL,
  jti_hash text PRIMARY KEY CHECK (jti_hash ~ '^[0-9a-f]{64}$'),
  certificate_hash text NOT NULL CHECK (certificate_hash ~ '^[0-9a-f]{64}$'),
  origin text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT sync_delivery_challenges_device_fk FOREIGN KEY (organization_id,device_id)
    REFERENCES devices (organization_id,id) ON DELETE RESTRICT
);
ALTER TABLE sync_delivery_challenges ENABLE ROW LEVEL SECURITY;
CREATE POLICY sync_delivery_challenges_tenant_isolation ON sync_delivery_challenges FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE (used_at) ON sync_delivery_challenges TO uco_app;
CREATE FUNCTION guard_delivery_nonce_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL OR NEW.used_at IS NULL OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.jti_hash IS DISTINCT FROM OLD.jti_hash
    OR NEW.certificate_hash IS DISTINCT FROM OLD.certificate_hash OR NEW.origin IS DISTINCT FROM OLD.origin
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'delivery challenge is immutable or already consumed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_delivery_nonce_use() FROM PUBLIC;
CREATE TRIGGER sync_delivery_challenge_one_use BEFORE UPDATE ON sync_delivery_challenges
  FOR EACH ROW EXECUTE FUNCTION guard_delivery_nonce_use();
