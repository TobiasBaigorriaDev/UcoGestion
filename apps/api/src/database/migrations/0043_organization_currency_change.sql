ALTER TABLE idempotency_records ALTER COLUMN branch_id DROP NOT NULL;
GRANT UPDATE (base_currency, version) ON organizations TO uco_app;

CREATE FUNCTION guard_organization_currency_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.base_currency IS NOT DISTINCT FROM OLD.base_currency THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM memberships WHERE organization_id = OLD.id
      AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND role = 'OWNER' AND status = 'ACTIVE' AND revoked_at IS NULL
  ) OR OLD.operational_history_started_at IS NOT NULL OR
    OLD.currency_permanently_locked_at IS NOT NULL OR
    EXISTS (SELECT 1 FROM offline_grants WHERE organization_id = OLD.id AND closed_at IS NULL) OR
    EXISTS (SELECT 1 FROM offline_configuration_exposures
      WHERE organization_id = OLD.id AND cleared_at IS NULL) OR
    EXISTS (SELECT 1 FROM configuration_barriers
      WHERE organization_id = OLD.id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'organization currency is locked or actor is not OWNER' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_organization_currency_change() FROM PUBLIC;
CREATE TRIGGER organizations_currency_change_guard
  BEFORE UPDATE OF base_currency ON organizations FOR EACH ROW
  EXECUTE FUNCTION guard_organization_currency_change();
