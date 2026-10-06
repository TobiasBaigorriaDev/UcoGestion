-- Protocol session identity exists before a commercial session is applied. A
-- rejected opening must retain evidence without creating a cash session.
CREATE TABLE offline_sync_sessions (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  device_id uuid NOT NULL,
  PRIMARY KEY (organization_id,id),
  CONSTRAINT offline_sync_sessions_device_fk FOREIGN KEY (organization_id,device_id)
    REFERENCES devices (organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT offline_sync_sessions_device_identity_key UNIQUE (organization_id,id,device_id)
);
ALTER TABLE offline_sync_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY offline_sync_sessions_tenant_isolation ON offline_sync_sessions FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT,INSERT ON offline_sync_sessions TO uco_app;
CREATE TRIGGER offline_sync_sessions_immutable BEFORE UPDATE OR DELETE ON offline_sync_sessions
  FOR EACH ROW EXECUTE FUNCTION prevent_offline_version_or_resource_mutation();

ALTER TABLE sync_operations
  ADD COLUMN session_id uuid,
  ADD COLUMN session_sequence bigint,
  ADD COLUMN kind text,
  ADD COLUMN envelope_hash text,
  ADD CONSTRAINT sync_operations_session_tenant_fk FOREIGN KEY (organization_id, session_id, device_id)
    REFERENCES offline_sync_sessions (organization_id, id, device_id) ON DELETE RESTRICT,
  ADD CONSTRAINT sync_operations_envelope_metadata_check CHECK (
    (session_id IS NULL AND session_sequence IS NULL AND kind IS NULL AND envelope_hash IS NULL)
    OR (session_id IS NOT NULL AND session_sequence > 0 AND session_sequence IS NOT NULL
      AND kind IS NOT NULL AND kind IN ('cash-session-open', 'sale-confirm')
      AND envelope_hash IS NOT NULL AND envelope_hash ~ '^[0-9a-f]{64}$')
  );

CREATE FUNCTION prevent_sync_envelope_metadata_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.session_sequence IS DISTINCT FROM OLD.session_sequence
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.envelope_hash IS DISTINCT FROM OLD.envelope_hash THEN
    RAISE EXCEPTION 'sealed envelope metadata is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION prevent_sync_envelope_metadata_change() FROM PUBLIC;
CREATE TRIGGER sync_operations_envelope_metadata_immutable
  BEFORE UPDATE ON sync_operations FOR EACH ROW EXECUTE FUNCTION prevent_sync_envelope_metadata_change();
