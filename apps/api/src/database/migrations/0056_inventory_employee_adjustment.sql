CREATE FUNCTION inventory_api.apply_adjustment(
  p_id uuid, p_organization_id uuid, p_branch_id uuid, p_item_id uuid,
  p_actor_user_id uuid, p_direction text, p_quantity numeric, p_reason text, p_observation text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_role text;
  v_unit text;
  v_balance numeric(20,3);
  v_delta numeric(20,3);
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR p_actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory context mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO v_role FROM memberships
    WHERE organization_id = p_organization_id AND user_id = p_actor_user_id
      AND status = 'ACTIVE' AND revoked_at IS NULL;
  IF v_role NOT IN ('OWNER', 'ADMIN', 'EMPLOYEE') OR v_role IS NULL
    OR (v_role = 'EMPLOYEE' AND p_reason = 'INVENTARIO_INICIAL') THEN
    RAISE EXCEPTION 'inventory adjustment forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_direction NOT IN ('INCREASE', 'DECREASE') OR p_direction IS NULL THEN
    RAISE EXCEPTION 'invalid adjustment direction' USING ERRCODE = '22023';
  END IF;
  IF p_reason NOT IN ('INVENTARIO_INICIAL', 'CONTEO_FISICO', 'ROTURA', 'PERDIDA',
      'VENCIMIENTO', 'CORRECCION', 'OTRO') OR p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid adjustment reason' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM branches WHERE organization_id = p_organization_id
      AND id = p_branch_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'active branch required' USING ERRCODE = '23503';
  END IF;
  IF v_role <> 'OWNER' AND NOT EXISTS (
    SELECT 1 FROM membership_branches mb JOIN memberships m
      ON m.organization_id = mb.organization_id AND m.id = mb.membership_id
    WHERE m.organization_id = p_organization_id AND m.user_id = p_actor_user_id
      AND mb.branch_id = p_branch_id
  ) THEN
    RAISE EXCEPTION 'branch access forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT base_unit INTO v_unit FROM catalog_items WHERE organization_id = p_organization_id
    AND id = p_item_id AND type = 'PRODUCT' AND track_inventory AND status = 'ACTIVE';
  IF v_unit IS NULL THEN
    RAISE EXCEPTION 'inventoried product required' USING ERRCODE = '23503';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR scale(p_quantity) > 3
    OR p_quantity > 99999999999999999.999
    OR (v_unit = 'UNIT' AND p_quantity <> trunc(p_quantity)) THEN
    RAISE EXCEPTION 'invalid quantity' USING ERRCODE = '22023';
  END IF;
  SELECT quantity INTO v_balance FROM branch_stocks WHERE organization_id = p_organization_id
    AND branch_id = p_branch_id AND item_id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock projection missing' USING ERRCODE = '23503';
  END IF;
  IF p_direction = 'DECREASE' AND v_balance < p_quantity THEN
    RAISE EXCEPTION 'insufficient stock' USING ERRCODE = '22023';
  END IF;
  v_delta := CASE WHEN p_direction = 'INCREASE' THEN p_quantity ELSE -p_quantity END;
  INSERT INTO inventory_adjustments
    (id, organization_id, branch_id, item_id, actor_user_id, direction, quantity, reason, observation)
    VALUES (p_id, p_organization_id, p_branch_id, p_item_id, p_actor_user_id,
      p_direction, p_quantity, p_reason, p_observation);
  INSERT INTO inventory_movements
    (id, organization_id, branch_id, item_id, actor_user_id, delta,
     source_type, source_id, source_line_id, effect_kind)
    VALUES (gen_random_uuid(), p_organization_id, p_branch_id, p_item_id, p_actor_user_id,
      v_delta, 'ADJUSTMENT', p_id, p_id, p_direction);
  UPDATE branch_stocks SET quantity = quantity + v_delta, version = version + 1
    WHERE organization_id = p_organization_id AND branch_id = p_branch_id AND item_id = p_item_id;
END;
$$;

REVOKE ALL ON FUNCTION inventory_api.apply_adjustment(uuid,uuid,uuid,uuid,uuid,text,numeric,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.apply_adjustment(uuid,uuid,uuid,uuid,uuid,text,numeric,text,text) TO uco_app;
