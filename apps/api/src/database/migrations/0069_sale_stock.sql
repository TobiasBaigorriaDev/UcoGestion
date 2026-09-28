ALTER TABLE sales ADD COLUMN session_owner_user_id uuid;
ALTER TABLE sales DISABLE TRIGGER sales_immutable;
UPDATE sales s SET session_owner_user_id = cs.owner_user_id
  FROM cash_sessions cs WHERE cs.organization_id = s.organization_id AND cs.id = s.cash_session_id;
ALTER TABLE sales ENABLE TRIGGER sales_immutable;
ALTER TABLE sales ALTER COLUMN session_owner_user_id SET NOT NULL;
ALTER TABLE sales ADD CONSTRAINT sales_session_owner_user_fk
  FOREIGN KEY (session_owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;

CREATE FUNCTION inventory_api.lock_sale_stock(
  p_organization_id uuid, p_branch_id uuid, p_item_id uuid, p_actor_user_id uuid, p_quantity numeric
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_balance numeric(20,3);
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR p_actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid
    OR p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'invalid sale stock context' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships m
    WHERE m.organization_id = p_organization_id AND m.user_id = p_actor_user_id
      AND m.status = 'ACTIVE' AND m.revoked_at IS NULL AND m.role IN ('OWNER', 'ADMIN', 'CASHIER')
      AND (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope s
        WHERE s.organization_id = m.organization_id AND s.membership_id = m.id
          AND s.branch_id = p_branch_id))) THEN
    RAISE EXCEPTION 'sale stock forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT quantity INTO v_balance FROM branch_stocks
    WHERE organization_id = p_organization_id AND branch_id = p_branch_id AND item_id = p_item_id FOR UPDATE;
  RETURN FOUND AND v_balance >= p_quantity;
END;
$$;
REVOKE ALL ON FUNCTION inventory_api.lock_sale_stock(uuid,uuid,uuid,uuid,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.lock_sale_stock(uuid,uuid,uuid,uuid,numeric) TO uco_app;

CREATE FUNCTION inventory_api.apply_sale_stock(
  p_organization_id uuid, p_sale_id uuid, p_sale_item_id uuid, p_actor_user_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_branch_id uuid;
DECLARE v_item_id uuid;
DECLARE v_quantity numeric(20,3);
DECLARE v_balance numeric(20,3);
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR p_actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid sale stock context' USING ERRCODE = '42501';
  END IF;
  SELECT s.branch_id, si.item_id, si.quantity INTO v_branch_id, v_item_id, v_quantity
    FROM sales s JOIN sale_items si ON si.organization_id = s.organization_id AND si.sale_id = s.id
    JOIN catalog_items ci ON ci.organization_id = si.organization_id AND ci.id = si.item_id
    WHERE s.organization_id = p_organization_id AND s.id = p_sale_id AND si.id = p_sale_item_id
      AND s.actor_user_id = p_actor_user_id AND ci.track_inventory;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid sale stock line' USING ERRCODE = '23503'; END IF;
  SELECT quantity INTO v_balance FROM branch_stocks WHERE organization_id = p_organization_id
    AND branch_id = v_branch_id AND item_id = v_item_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_quantity THEN
    RAISE EXCEPTION 'insufficient sale stock' USING ERRCODE = '22023';
  END IF;
  INSERT INTO inventory_movements (id, organization_id, branch_id, item_id, actor_user_id,
    delta, source_type, source_id, source_line_id, effect_kind)
    VALUES (gen_random_uuid(), p_organization_id, v_branch_id, v_item_id, p_actor_user_id,
      -v_quantity, 'SALE', p_sale_id, p_sale_item_id, 'DECREASE');
  UPDATE branch_stocks SET quantity = quantity - v_quantity, version = version + 1
    WHERE organization_id = p_organization_id AND branch_id = v_branch_id AND item_id = v_item_id;
END;
$$;
REVOKE ALL ON FUNCTION inventory_api.apply_sale_stock(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.apply_sale_stock(uuid,uuid,uuid,uuid) TO uco_app;
