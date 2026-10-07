CREATE TABLE offline_delivery_results (
  organization_id uuid NOT NULL,
  device_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  envelope_hash text NOT NULL CHECK (envelope_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('ACKED','SECURITY_REJECTED')),
  ack_jws text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,device_id,operation_id),
  FOREIGN KEY (organization_id,device_id) REFERENCES devices (organization_id,id) ON DELETE RESTRICT
);
ALTER TABLE offline_delivery_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY offline_delivery_results_tenant_isolation ON offline_delivery_results FOR ALL TO uco_app
 USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT,INSERT ON offline_delivery_results TO uco_app;
CREATE TRIGGER offline_delivery_results_immutable BEFORE UPDATE OR DELETE ON offline_delivery_results
 FOR EACH ROW EXECUTE FUNCTION prevent_offline_version_or_resource_mutation();
