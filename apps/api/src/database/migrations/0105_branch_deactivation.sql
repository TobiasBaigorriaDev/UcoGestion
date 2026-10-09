GRANT UPDATE (status, version) ON branches TO uco_app;

CREATE FUNCTION guard_branch_deactivation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Administrative migration/fixture roles are outside the runtime tenant boundary.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'INACTIVE' THEN
    RAISE EXCEPTION 'branch reactivation is not an ordinary runtime operation' USING ERRCODE='42501';
  END IF;
  IF NEW.status = 'INACTIVE' AND OLD.status = 'ACTIVE' THEN
    IF NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id=OLD.organization_id
      AND user_id=nullif(current_setting('app.user_id',true),'')::uuid
      AND role='OWNER' AND status='ACTIVE' AND revoked_at IS NULL) THEN
      RAISE EXCEPTION 'branch deactivation requires owner' USING ERRCODE='42501';
    END IF;
    IF EXISTS (SELECT 1 FROM cash_sessions WHERE organization_id=OLD.organization_id AND branch_id=OLD.id
        AND status IN ('OPEN','CLOSING','CONFLICTED'))
      OR EXISTS (SELECT 1 FROM sync_operations s JOIN devices d ON d.organization_id=s.organization_id AND d.id=s.device_id
        WHERE s.organization_id=OLD.organization_id AND d.branch_id=OLD.id AND s.status='PENDING')
      OR EXISTS (SELECT 1 FROM inventory_incidents WHERE organization_id=OLD.organization_id AND branch_id=OLD.id AND status<>'RESOLVED')
      OR EXISTS (SELECT 1 FROM offline_configuration_exposures e
        JOIN offline_exposure_resources r ON r.organization_id=e.organization_id AND r.exposure_id=e.id
        LEFT JOIN cash_registers cr ON cr.organization_id=r.organization_id AND cr.id=r.cash_register_id
        WHERE e.organization_id=OLD.organization_id AND e.cleared_at IS NULL AND (r.branch_id=OLD.id OR cr.branch_id=OLD.id)) THEN
      RAISE EXCEPTION 'branch has unresolved operations or uncertainty' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_branch_deactivation() FROM PUBLIC;
CREATE TRIGGER branches_deactivation_guard BEFORE UPDATE OF status ON branches
  FOR EACH ROW EXECUTE FUNCTION guard_branch_deactivation();
