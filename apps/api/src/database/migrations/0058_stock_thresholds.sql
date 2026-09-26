CREATE TABLE stock_thresholds (
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  item_id uuid NOT NULL,
  minimum numeric(20,3) NOT NULL CHECK (minimum >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, branch_id, item_id),
  CONSTRAINT stock_thresholds_stock_tenant_fk FOREIGN KEY (organization_id, branch_id, item_id)
    REFERENCES branch_stocks (organization_id, branch_id, item_id) ON DELETE RESTRICT
);

ALTER TABLE stock_thresholds ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_thresholds_tenant_isolation ON stock_thresholds
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT ON stock_thresholds TO uco_app;

CREATE FUNCTION inventory_api.set_threshold(
  p_organization_id uuid, p_branch_id uuid, p_item_id uuid, p_actor_user_id uuid, p_minimum numeric
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_unit text;
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR p_actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory context mismatch' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id = p_organization_id
    AND user_id = p_actor_user_id AND role = 'OWNER' AND status = 'ACTIVE' AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'threshold forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM branches WHERE organization_id = p_organization_id
    AND id = p_branch_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'active branch required' USING ERRCODE = '23503';
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

REVOKE ALL ON FUNCTION inventory_api.set_threshold(uuid,uuid,uuid,uuid,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.set_threshold(uuid,uuid,uuid,uuid,numeric) TO uco_app;
