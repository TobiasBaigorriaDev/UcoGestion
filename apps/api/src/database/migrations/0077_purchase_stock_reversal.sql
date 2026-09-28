CREATE FUNCTION inventory_api.reverse_purchase_stock(
  p_organization_id uuid, p_purchase_id uuid, p_cancellation_id uuid, p_actor_user_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_branch_id uuid;
DECLARE v_stock record;
DECLARE v_movement record;
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR p_actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid purchase reversal context' USING ERRCODE = '42501';
  END IF;
  SELECT branch_id INTO v_branch_id FROM purchase_cancellations
    WHERE organization_id = p_organization_id AND purchase_id = p_purchase_id
      AND id = p_cancellation_id AND actor_user_id = p_actor_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'purchase cancellation missing' USING ERRCODE = '23503'; END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships m
    WHERE m.organization_id = p_organization_id AND m.user_id = p_actor_user_id
      AND m.status = 'ACTIVE' AND m.revoked_at IS NULL AND m.role IN ('OWNER', 'ADMIN')
      AND (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope s
        WHERE s.organization_id = m.organization_id AND s.membership_id = m.id
          AND s.branch_id = v_branch_id))) THEN
    RAISE EXCEPTION 'purchase reversal forbidden' USING ERRCODE = '42501';
  END IF;
  -- Acquire every stock lock in canonical branch/item order, then validate all balances.
  FOR v_stock IN
    SELECT bs.branch_id, bs.item_id, bs.quantity,
      SUM(im.delta) AS required_quantity
    FROM inventory_movements im JOIN branch_stocks bs
      ON bs.organization_id = im.organization_id AND bs.branch_id = im.branch_id
        AND bs.item_id = im.item_id
    WHERE im.organization_id = p_organization_id AND im.source_type = 'PURCHASE'
      AND im.source_id = p_purchase_id AND im.effect_kind = 'INCREASE'
    GROUP BY bs.branch_id, bs.item_id, bs.quantity
    ORDER BY bs.branch_id, bs.item_id
  LOOP
    PERFORM 1 FROM branch_stocks WHERE organization_id = p_organization_id
      AND branch_id = v_stock.branch_id AND item_id = v_stock.item_id FOR UPDATE;
  END LOOP;
  FOR v_stock IN
    SELECT bs.branch_id, bs.item_id, bs.quantity,
      SUM(im.delta) AS required_quantity
    FROM inventory_movements im JOIN branch_stocks bs
      ON bs.organization_id = im.organization_id AND bs.branch_id = im.branch_id
        AND bs.item_id = im.item_id
    WHERE im.organization_id = p_organization_id AND im.source_type = 'PURCHASE'
      AND im.source_id = p_purchase_id AND im.effect_kind = 'INCREASE'
    GROUP BY bs.branch_id, bs.item_id, bs.quantity
    ORDER BY bs.branch_id, bs.item_id
  LOOP
    IF v_stock.quantity < v_stock.required_quantity THEN
      RAISE EXCEPTION 'insufficient stock for purchase reversal' USING ERRCODE = 'P1640';
    END IF;
  END LOOP;
  FOR v_movement IN
    SELECT branch_id, item_id, source_line_id, delta FROM inventory_movements
    WHERE organization_id = p_organization_id AND source_type = 'PURCHASE'
      AND source_id = p_purchase_id AND effect_kind = 'INCREASE'
    ORDER BY branch_id, item_id, source_line_id
  LOOP
    INSERT INTO inventory_movements (id, organization_id, branch_id, item_id,
      actor_user_id, delta, source_type, source_id, source_line_id, effect_kind)
      VALUES (gen_random_uuid(), p_organization_id, v_movement.branch_id, v_movement.item_id,
        p_actor_user_id, -v_movement.delta, 'PURCHASE_CANCELLATION', p_cancellation_id,
        v_movement.source_line_id, 'DECREASE');
    UPDATE branch_stocks SET quantity = quantity - v_movement.delta, version = version + 1
      WHERE organization_id = p_organization_id AND branch_id = v_movement.branch_id
        AND item_id = v_movement.item_id;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION inventory_api.reverse_purchase_stock(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.reverse_purchase_stock(uuid,uuid,uuid,uuid) TO uco_app;
