ALTER TABLE organizations
  ADD COLUMN config_epoch bigint NOT NULL DEFAULT 1 CHECK (config_epoch > 0);

ALTER TABLE offline_grants
  ADD COLUMN closed_at timestamptz,
  ADD CONSTRAINT offline_grants_device_epoch_key UNIQUE (organization_id, id, device_id, epoch);

CREATE TABLE configuration_barriers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  epoch bigint NOT NULL CHECK (epoch > 0),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT configuration_barriers_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT configuration_barriers_status_time_check CHECK (
    (status = 'ACTIVE' AND completed_at IS NULL) OR
    (status = 'COMPLETED' AND completed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX configuration_barriers_one_active_key
  ON configuration_barriers (organization_id) WHERE status = 'ACTIVE';

CREATE TABLE sync_operations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  device_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  epoch bigint NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  operation_hash text NOT NULL CHECK (operation_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('PENDING', 'ACKED', 'SECURITY_REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_operations_grant_fk FOREIGN KEY (organization_id, grant_id, device_id, epoch)
    REFERENCES offline_grants (organization_id, id, device_id, epoch) ON DELETE RESTRICT,
  CONSTRAINT sync_operations_device_epoch_sequence_key UNIQUE (organization_id, device_id, epoch, sequence)
);

CREATE TABLE configuration_checkpoints (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  barrier_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  epoch bigint NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  head_hash text NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  canonical_payload text NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT configuration_checkpoints_barrier_fk FOREIGN KEY (organization_id, barrier_id)
    REFERENCES configuration_barriers (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT configuration_checkpoints_grant_fk FOREIGN KEY (organization_id, grant_id, device_id, epoch)
    REFERENCES offline_grants (organization_id, id, device_id, epoch) ON DELETE RESTRICT
);

ALTER TABLE configuration_barriers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuration_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY configuration_barriers_tenant_isolation ON configuration_barriers FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY sync_operations_tenant_isolation ON sync_operations FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY configuration_checkpoints_tenant_isolation ON configuration_checkpoints FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE (status, completed_at) ON configuration_barriers TO uco_app;
GRANT SELECT, INSERT, UPDATE (status) ON sync_operations TO uco_app;
GRANT SELECT, INSERT ON configuration_checkpoints TO uco_app;
GRANT INSERT, UPDATE (closed_at) ON offline_grants TO uco_app;
GRANT UPDATE (cleared_at) ON offline_configuration_exposures TO uco_app;
GRANT UPDATE (config_epoch) ON organizations TO uco_app;

CREATE TRIGGER configuration_checkpoints_immutable
  BEFORE UPDATE OR DELETE ON configuration_checkpoints FOR EACH ROW
  EXECUTE FUNCTION prevent_offline_version_or_resource_mutation();

CREATE FUNCTION guard_offline_grant_issuance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_epoch bigint;
DECLARE current_currency text;
DECLARE signed_currency text;
BEGIN
  SELECT config_epoch, base_currency INTO current_epoch, current_currency
    FROM organizations WHERE id = NEW.organization_id FOR UPDATE;
  SELECT snapshot->>'currency' INTO signed_currency FROM configuration_versions
    WHERE organization_id = NEW.organization_id AND version = NEW.configuration_version;
  IF current_epoch IS NULL OR NEW.epoch <> current_epoch OR EXISTS (
    SELECT 1 FROM configuration_barriers
    WHERE organization_id = NEW.organization_id AND status = 'ACTIVE'
  ) OR signed_currency IS DISTINCT FROM current_currency THEN
    RAISE EXCEPTION 'grant issuance blocked by configuration barrier or stale epoch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_offline_grant_issuance() FROM PUBLIC;
CREATE TRIGGER offline_grants_issue_guard
  BEFORE INSERT ON offline_grants FOR EACH ROW EXECUTE FUNCTION guard_offline_grant_issuance();

CREATE FUNCTION coordinate_sync_operation_with_configuration_barrier()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_epoch bigint;
DECLARE grant_closed_at timestamptz;
BEGIN
  SELECT config_epoch INTO current_epoch FROM organizations
    WHERE id = NEW.organization_id FOR UPDATE;
  SELECT closed_at INTO grant_closed_at FROM offline_grants
    WHERE organization_id = NEW.organization_id AND id = NEW.grant_id;
  IF NOT FOUND OR grant_closed_at IS NOT NULL OR NEW.epoch <> current_epoch THEN
    RAISE EXCEPTION 'sync operation belongs to a closed or stale grant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION coordinate_sync_operation_with_configuration_barrier() FROM PUBLIC;
CREATE TRIGGER sync_operations_configuration_lock
  BEFORE INSERT ON sync_operations FOR EACH ROW
  EXECUTE FUNCTION coordinate_sync_operation_with_configuration_barrier();

CREATE FUNCTION prevent_sync_operation_reversal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDING' OR NEW.status NOT IN ('ACKED', 'SECURITY_REJECTED') OR
    NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.grant_id IS DISTINCT FROM OLD.grant_id OR
    NEW.epoch IS DISTINCT FROM OLD.epoch OR NEW.sequence IS DISTINCT FROM OLD.sequence OR
    NEW.prev_hash IS DISTINCT FROM OLD.prev_hash OR NEW.operation_hash IS DISTINCT FROM OLD.operation_hash THEN
    RAISE EXCEPTION 'sync operation state is immutable after a definitive result' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION prevent_sync_operation_reversal() FROM PUBLIC;
CREATE TRIGGER sync_operations_no_reversal BEFORE UPDATE ON sync_operations FOR EACH ROW
  EXECUTE FUNCTION prevent_sync_operation_reversal();

CREATE FUNCTION prevent_offline_clear_or_close_reversal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'offline_grants' THEN
    IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
      RAISE EXCEPTION 'closed grant cannot reopen' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'offline_configuration_exposures' THEN
    IF OLD.cleared_at IS NOT NULL AND NEW.cleared_at IS DISTINCT FROM OLD.cleared_at THEN
      RAISE EXCEPTION 'cleared exposure cannot reopen' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION prevent_offline_clear_or_close_reversal() FROM PUBLIC;
CREATE TRIGGER offline_grants_no_reopen BEFORE UPDATE ON offline_grants FOR EACH ROW
  EXECUTE FUNCTION prevent_offline_clear_or_close_reversal();
CREATE TRIGGER offline_exposures_no_reopen BEFORE UPDATE ON offline_configuration_exposures FOR EACH ROW
  EXECUTE FUNCTION prevent_offline_clear_or_close_reversal();
