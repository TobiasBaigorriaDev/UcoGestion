CREATE OR REPLACE FUNCTION inventory_api.set_threshold(
  p_organization_id uuid, p_branch_id uuid, p_item_id uuid, p_actor_user_id uuid, p_minimum numeric
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_unit text;
  v_membership_id uuid;
  v_role text;
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR p_actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory context mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT id, role INTO v_membership_id, v_role FROM memberships
    WHERE organization_id = p_organization_id AND user_id = p_actor_user_id
      AND status = 'ACTIVE' AND revoked_at IS NULL;
  IF v_role NOT IN ('OWNER', 'ADMIN', 'EMPLOYEE') OR v_role IS NULL THEN
    RAISE EXCEPTION 'threshold forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM branches b WHERE b.organization_id = p_organization_id
    AND b.id = p_branch_id AND b.status = 'ACTIVE' AND EXISTS (
      SELECT 1 FROM effective_membership_branch_scope s
      WHERE s.organization_id = b.organization_id AND s.branch_id = b.id
        AND s.membership_id = v_membership_id)) THEN
    RAISE EXCEPTION 'branch access forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT base_unit INTO v_unit FROM catalog_items WHERE organization_id = p_organization_id
    AND id = p_item_id AND type = 'PRODUCT' AND track_inventory AND status = 'ACTIVE';
  IF v_unit IS NULL THEN
    RAISE EXCEPTION 'inventoried product required' USING ERRCODE = '23503';
  END IF;
  IF p_minimum IS NOT NULL AND (p_minimum < 0 OR scale(p_minimum) > 3
    OR p_minimum > 99999999999999999.999
    OR (v_unit = 'UNIT' AND p_minimum <> trunc(p_minimum))) THEN
    RAISE EXCEPTION 'invalid threshold' USING ERRCODE = '22023';
  END IF;
  IF p_minimum IS NULL THEN
    DELETE FROM stock_thresholds WHERE organization_id = p_organization_id
      AND branch_id = p_branch_id AND item_id = p_item_id;
  ELSE
    INSERT INTO stock_thresholds (organization_id, branch_id, item_id, minimum)
      VALUES (p_organization_id, p_branch_id, p_item_id, p_minimum)
      ON CONFLICT (organization_id, branch_id, item_id) DO UPDATE
        SET minimum = EXCLUDED.minimum, updated_at = now();
  END IF;
END;
$$;
