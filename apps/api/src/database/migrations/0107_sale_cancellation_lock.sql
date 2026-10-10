-- SELECT FOR UPDATE needs UPDATE on at least one column. The immutable trigger
-- rejects every UPDATE/DELETE; this grant permits locking, never rewriting a sale.
GRANT UPDATE (id) ON sales TO uco_app;

CREATE FUNCTION inventory_api.reverse_sale_stock(p_org uuid,p_sale uuid,p_cancellation uuid,p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_branch uuid; v_movement record;
BEGIN
  IF p_org IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR p_actor IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
    RAISE EXCEPTION 'sale reversal context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT s.branch_id INTO v_branch FROM sales s JOIN sale_cancellations c
    ON c.organization_id=s.organization_id AND c.sale_id=s.id
    WHERE s.organization_id=p_org AND s.id=p_sale AND c.id=p_cancellation AND c.actor_user_id=p_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'sale cancellation unavailable' USING ERRCODE='23503'; END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id=p_org AND m.user_id=p_actor
    AND m.status='ACTIVE' AND m.revoked_at IS NULL AND m.role IN ('OWNER','ADMIN')
    AND (m.role='OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope scope
      WHERE scope.organization_id=p_org AND scope.membership_id=m.id AND scope.branch_id=v_branch))) THEN
    RAISE EXCEPTION 'sale reversal forbidden' USING ERRCODE='42501';
  END IF;
  FOR v_movement IN SELECT branch_id,item_id,source_line_id,-delta AS quantity FROM inventory_movements
    WHERE organization_id=p_org AND source_type='SALE' AND source_id=p_sale AND effect_kind='DECREASE'
    ORDER BY branch_id,item_id,source_line_id LOOP
    PERFORM 1 FROM branch_stocks WHERE organization_id=p_org AND branch_id=v_movement.branch_id
      AND item_id=v_movement.item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'sale stock projection missing' USING ERRCODE='23503'; END IF;
    INSERT INTO inventory_movements(id,organization_id,branch_id,item_id,actor_user_id,delta,
      source_type,source_id,source_line_id,effect_kind)
      VALUES(gen_random_uuid(),p_org,v_movement.branch_id,v_movement.item_id,p_actor,v_movement.quantity,
        'SALE_CANCELLATION',p_cancellation,v_movement.source_line_id,'INCREASE');
    UPDATE branch_stocks SET quantity=quantity+v_movement.quantity,version=version+1
      WHERE organization_id=p_org AND branch_id=v_movement.branch_id AND item_id=v_movement.item_id;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION inventory_api.reverse_sale_stock(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.reverse_sale_stock(uuid,uuid,uuid,uuid) TO uco_app;
