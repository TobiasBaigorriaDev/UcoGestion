ALTER TABLE cash_registers
  ADD CONSTRAINT cash_registers_organization_id_id_key UNIQUE (organization_id, id);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'UNRECOVERABLE')),
  public_key text NOT NULL,
  last_config_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_organization_id_id_key UNIQUE (organization_id, id)
);

CREATE TABLE configuration_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  canonical_payload text NOT NULL,
  signature text NOT NULL,
  signing_key_id text NOT NULL,
  public_key_pem text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT configuration_versions_org_version_key UNIQUE (organization_id, version)
);

CREATE TABLE offline_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  device_id uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  configuration_version bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offline_grants_device_fk FOREIGN KEY (organization_id, device_id)
    REFERENCES devices (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT offline_grants_configuration_fk FOREIGN KEY (organization_id, configuration_version)
    REFERENCES configuration_versions (organization_id, version) ON DELETE RESTRICT,
  CONSTRAINT offline_grants_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT offline_grants_exposure_identity_key
    UNIQUE (organization_id, id, device_id, epoch, configuration_version)
);

CREATE TABLE offline_configuration_exposures (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  device_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  epoch bigint NOT NULL,
  configuration_version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  CONSTRAINT offline_configuration_exposures_grant_fk
    FOREIGN KEY (organization_id, grant_id, device_id, epoch, configuration_version)
    REFERENCES offline_grants (organization_id, id, device_id, epoch, configuration_version)
    ON DELETE RESTRICT,
  CONSTRAINT offline_configuration_exposures_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT offline_configuration_exposures_grant_key UNIQUE (organization_id, grant_id)
);

CREATE TABLE offline_exposure_resources (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  exposure_id uuid NOT NULL,
  catalog_item_id uuid,
  catalog_category_id uuid,
  branch_id uuid,
  cash_register_id uuid,
  payment_method text,
  CONSTRAINT offline_exposure_resources_one_target_check CHECK (
    num_nonnulls(catalog_item_id, catalog_category_id, branch_id, cash_register_id, payment_method) = 1
  ),
  CONSTRAINT offline_exposure_resources_exposure_fk FOREIGN KEY (organization_id, exposure_id)
    REFERENCES offline_configuration_exposures (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT offline_exposure_resources_catalog_item_fk FOREIGN KEY (organization_id, catalog_item_id)
    REFERENCES catalog_items (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT offline_exposure_resources_catalog_category_fk FOREIGN KEY (organization_id, catalog_category_id)
    REFERENCES catalog_categories (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT offline_exposure_resources_branch_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT offline_exposure_resources_cash_register_fk FOREIGN KEY (organization_id, cash_register_id)
    REFERENCES cash_registers (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT offline_exposure_resources_payment_method_fk FOREIGN KEY (organization_id, payment_method)
    REFERENCES payment_method_settings (organization_id, method) ON DELETE RESTRICT
);

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuration_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_configuration_exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_exposure_resources ENABLE ROW LEVEL SECURITY;

CREATE POLICY devices_tenant_isolation ON devices FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY configuration_versions_tenant_isolation ON configuration_versions FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY offline_grants_tenant_isolation ON offline_grants FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY offline_configuration_exposures_tenant_isolation ON offline_configuration_exposures FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY offline_exposure_resources_tenant_isolation ON offline_exposure_resources FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT ON devices, offline_grants TO uco_app;
GRANT SELECT, INSERT ON configuration_versions, offline_configuration_exposures, offline_exposure_resources TO uco_app;

CREATE FUNCTION prevent_offline_version_or_resource_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'offline configuration history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION prevent_offline_version_or_resource_mutation() FROM PUBLIC;
CREATE TRIGGER configuration_versions_immutable
  BEFORE UPDATE OR DELETE ON configuration_versions FOR EACH ROW
  EXECUTE FUNCTION prevent_offline_version_or_resource_mutation();
CREATE TRIGGER offline_exposure_resources_immutable
  BEFORE UPDATE OR DELETE ON offline_exposure_resources FOR EACH ROW
  EXECUTE FUNCTION prevent_offline_version_or_resource_mutation();
