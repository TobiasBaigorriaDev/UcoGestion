-- Catalog edits can advance the epoch while historical grants remain open.
-- New grants still require the current epoch; sealed operations use their
-- retained authorization and snapshot, validated by historical ingestion.
CREATE OR REPLACE FUNCTION coordinate_sync_operation_with_configuration_barrier()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_epoch bigint;
DECLARE grant_closed_at timestamptz;
BEGIN
  SELECT config_epoch INTO current_epoch FROM organizations
    WHERE id = NEW.organization_id FOR UPDATE;
  SELECT closed_at INTO grant_closed_at FROM offline_grants
    WHERE organization_id = NEW.organization_id AND id = NEW.grant_id;
  IF NOT FOUND OR grant_closed_at IS NOT NULL OR current_epoch IS NULL
    OR NEW.epoch > current_epoch THEN
    RAISE EXCEPTION 'sync operation belongs to a closed or stale grant' USING ERRCODE = '23514';
  END IF;
  IF NEW.epoch <> current_epoch AND (
    NEW.envelope_hash IS NULL OR NEW.session_id IS NULL OR NEW.session_sequence IS NULL OR NEW.kind IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM offline_grant_authorizations a
      WHERE a.organization_id = NEW.organization_id AND a.grant_id = NEW.grant_id
        AND a.actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND NEW.occurred_at >= a.issued_at AND NEW.occurred_at < a.expires_at
    )
  ) THEN
    RAISE EXCEPTION 'sync operation belongs to a closed or stale grant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION coordinate_sync_operation_with_configuration_barrier() FROM PUBLIC;
