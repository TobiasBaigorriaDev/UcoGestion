-- Global public cryptographic infrastructure: contains no tenant or business data.
CREATE TABLE offline_ingestion_key_registry (
  key_id text PRIMARY KEY CHECK (key_id <> ''),
  public_key_pem text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON offline_ingestion_key_registry TO uco_app;
CREATE TRIGGER offline_ingestion_key_registry_immutable
  BEFORE UPDATE OR DELETE ON offline_ingestion_key_registry FOR EACH ROW
  EXECUTE FUNCTION prevent_offline_version_or_resource_mutation();
