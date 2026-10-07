CREATE FUNCTION inventory_api.lock_incident_stock(p_org uuid,p_incident uuid)
 RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_incident record;v_quantity numeric;
BEGIN
 IF p_org IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
  RAISE EXCEPTION 'incident tenant forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_incident FROM inventory_incidents WHERE organization_id=p_org AND id=p_incident;
 IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id=p_org
 AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid AND m.status='ACTIVE' AND m.revoked_at IS NULL
 AND m.role IN ('OWNER','ADMIN') AND (m.role='OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope scope
 WHERE scope.organization_id=m.organization_id AND scope.membership_id=m.id AND scope.branch_id=v_incident.branch_id))) THEN
  RAISE EXCEPTION 'incident resolution forbidden' USING ERRCODE='42501'; END IF;
 SELECT quantity INTO v_quantity FROM branch_stocks WHERE organization_id=p_org AND branch_id=v_incident.branch_id AND item_id=v_incident.item_id FOR UPDATE;
 RETURN v_quantity;
END;
$$;
REVOKE ALL ON FUNCTION inventory_api.lock_incident_stock(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.lock_incident_stock(uuid,uuid) TO uco_app;
CREATE FUNCTION inventory_api.guard_incident_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status='RESOLVED' THEN
  RAISE EXCEPTION 'resolved incident history is immutable' USING ERRCODE='55000'; END IF;
 IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.branch_id<>OLD.branch_id OR NEW.item_id<>OLD.item_id
 OR NEW.created_at<>OLD.created_at OR NEW.max_shortfall<OLD.max_shortfall THEN
  RAISE EXCEPTION 'incident history mutation' USING ERRCODE='55000'; END IF;
 IF NEW.status='RESOLVED' THEN
  IF OLD.status<>'PENDING_REVIEW' OR NEW.resolved_by_user_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
   OR inventory_api.lock_incident_stock(NEW.organization_id,NEW.id)<0 THEN
   RAISE EXCEPTION 'negative or unreviewed incident' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION inventory_api.guard_incident_history() FROM PUBLIC;
CREATE TRIGGER inventory_incident_history BEFORE UPDATE OR DELETE ON inventory_incidents
 FOR EACH ROW EXECUTE FUNCTION inventory_api.guard_incident_history();
