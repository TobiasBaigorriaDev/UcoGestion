CREATE TABLE offline_revocation_checkpoints (
 organization_id uuid NOT NULL,
 device_id uuid NOT NULL,
 target text NOT NULL,
 actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
 sequence bigint NOT NULL CHECK (sequence >= 0),
 head_hash text NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
 signature text NOT NULL,
 known_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (organization_id,device_id,target),
 FOREIGN KEY (organization_id,device_id) REFERENCES devices (organization_id,id) ON DELETE RESTRICT,
 CHECK ((actor_user_id IS NULL AND target='DEVICE') OR target=actor_user_id::text)
);
ALTER TABLE offline_revocation_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY offline_revocation_checkpoints_tenant_isolation ON offline_revocation_checkpoints FOR ALL TO uco_app
 USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT,INSERT ON offline_revocation_checkpoints TO uco_app;
CREATE TRIGGER offline_revocation_checkpoints_immutable BEFORE UPDATE OR DELETE ON offline_revocation_checkpoints
 FOR EACH ROW EXECUTE FUNCTION prevent_offline_version_or_resource_mutation();
