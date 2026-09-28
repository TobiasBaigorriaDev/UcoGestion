CREATE FUNCTION inventory_api.apply_purchase_stock(
  p_organization_id uuid, p_purchase_id uuid, p_purchase_item_id uuid, p_actor_user_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_branch_id uuid;
DECLARE v_item_id uuid;
DECLARE v_quantity numeric(20,3);
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR p_actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid purchase stock context' USING ERRCODE = '42501';
  END IF;
  SELECT p.branch_id, pi.item_id, pi.quantity INTO v_branch_id, v_item_id, v_quantity
    FROM purchases p JOIN purchase_items pi ON pi.organization_id = p.organization_id
      AND pi.purchase_id = p.id
    WHERE p.organization_id = p_organization_id AND p.id = p_purchase_id
      AND pi.id = p_purchase_item_id AND p.actor_user_id = p_actor_user_id
      AND pi.track_inventory AND p.confirmation_status IN ('PENDING_PAYMENT', 'PAID');
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid purchase stock line' USING ERRCODE = '23503'; END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships m
    WHERE m.organization_id = p_organization_id AND m.user_id = p_actor_user_id
      AND m.status = 'ACTIVE' AND m.revoked_at IS NULL AND m.role IN ('OWNER', 'ADMIN', 'EMPLOYEE')
      AND (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope s
        WHERE s.organization_id = m.organization_id AND s.membership_id = m.id
          AND s.branch_id = v_branch_id))) THEN
    RAISE EXCEPTION 'purchase stock forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM branch_stocks WHERE organization_id = p_organization_id
    AND branch_id = v_branch_id AND item_id = v_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'purchase stock projection missing' USING ERRCODE = '23503'; END IF;
  INSERT INTO inventory_movements (id, organization_id, branch_id, item_id, actor_user_id,
    delta, source_type, source_id, source_line_id, effect_kind)
    VALUES (gen_random_uuid(), p_organization_id, v_branch_id, v_item_id, p_actor_user_id,
      v_quantity, 'PURCHASE', p_purchase_id, p_purchase_item_id, 'INCREASE');
  UPDATE branch_stocks SET quantity = quantity + v_quantity, version = version + 1
    WHERE organization_id = p_organization_id AND branch_id = v_branch_id AND item_id = v_item_id;
END;
$$;
REVOKE ALL ON FUNCTION inventory_api.apply_purchase_stock(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.apply_purchase_stock(uuid,uuid,uuid,uuid) TO uco_app;
