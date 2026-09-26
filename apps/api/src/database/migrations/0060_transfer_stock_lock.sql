CREATE FUNCTION inventory_api.lock_transfer_stock(
  p_organization_id uuid, p_branch_id uuid, p_item_id uuid, p_actor_user_id uuid, p_quantity numeric
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_membership_id uuid;
  v_role text;
  v_balance numeric(20,3);
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR p_actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory context mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT id, role INTO v_membership_id, v_role FROM memberships
    WHERE organization_id = p_organization_id AND user_id = p_actor_user_id
      AND status = 'ACTIVE' AND revoked_at IS NULL;
  IF v_role NOT IN ('OWNER', 'ADMIN', 'EMPLOYEE') OR v_role IS NULL
    OR NOT EXISTS (SELECT 1 FROM effective_membership_branch_scope s
      WHERE s.organization_id = p_organization_id AND s.membership_id = v_membership_id
        AND s.branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'transfer stock forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT quantity INTO v_balance FROM branch_stocks
    WHERE organization_id = p_organization_id AND branch_id = p_branch_id AND item_id = p_item_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer stock missing' USING ERRCODE = '23503';
  END IF;
  RETURN v_balance < p_quantity;
END;
$$;

REVOKE ALL ON FUNCTION inventory_api.lock_transfer_stock(uuid,uuid,uuid,uuid,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.lock_transfer_stock(uuid,uuid,uuid,uuid,numeric) TO uco_app;
