CREATE TABLE inventory_adjustments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  item_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('INCREASE', 'DECREASE')),
  quantity numeric(20,3) NOT NULL CHECK (quantity > 0),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  observation text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_adjustments_branch_tenant_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_adjustments_item_tenant_fk FOREIGN KEY (organization_id, item_id)
    REFERENCES catalog_items (organization_id, id) ON DELETE RESTRICT
);

ALTER TABLE inventory_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_adjustments_tenant_isolation ON inventory_adjustments
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT ON inventory_adjustments TO uco_app;

CREATE FUNCTION prevent_inventory_adjustment_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_adjustments are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER inventory_adjustments_immutable BEFORE UPDATE OR DELETE ON inventory_adjustments
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_adjustment_mutation();

CREATE SCHEMA inventory_api;
REVOKE ALL ON SCHEMA inventory_api FROM PUBLIC;
GRANT USAGE ON SCHEMA inventory_api TO uco_app;

CREATE FUNCTION inventory_api.apply_increase(
  p_id uuid, p_organization_id uuid, p_branch_id uuid, p_item_id uuid,
  p_actor_user_id uuid, p_quantity numeric, p_reason text, p_observation text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_role text;
  v_unit text;
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR p_actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory context mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO v_role FROM memberships
    WHERE organization_id = p_organization_id AND user_id = p_actor_user_id
      AND status = 'ACTIVE' AND revoked_at IS NULL;
  IF v_role NOT IN ('OWNER', 'ADMIN') OR v_role IS NULL THEN
    RAISE EXCEPTION 'inventory increase forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM branches WHERE organization_id = p_organization_id
      AND id = p_branch_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'active branch required' USING ERRCODE = '23503';
  END IF;
  IF v_role = 'ADMIN' AND NOT EXISTS (
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
  PERFORM 1 FROM branch_stocks WHERE organization_id = p_organization_id
    AND branch_id = p_branch_id AND item_id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock projection missing' USING ERRCODE = '23503';
  END IF;
  INSERT INTO inventory_adjustments
    (id, organization_id, branch_id, item_id, actor_user_id, direction, quantity, reason, observation)
    VALUES (p_id, p_organization_id, p_branch_id, p_item_id, p_actor_user_id,
      'INCREASE', p_quantity, p_reason, p_observation);
  INSERT INTO inventory_movements
    (id, organization_id, branch_id, item_id, actor_user_id, delta,
     source_type, source_id, source_line_id, effect_kind)
    VALUES (gen_random_uuid(), p_organization_id, p_branch_id, p_item_id, p_actor_user_id,
      p_quantity, 'ADJUSTMENT', p_id, p_id, 'INCREASE');
  UPDATE branch_stocks SET quantity = quantity + p_quantity, version = version + 1
    WHERE organization_id = p_organization_id AND branch_id = p_branch_id AND item_id = p_item_id;
END;
$$;

REVOKE ALL ON FUNCTION inventory_api.apply_increase(uuid,uuid,uuid,uuid,uuid,numeric,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.apply_increase(uuid,uuid,uuid,uuid,uuid,numeric,text,text) TO uco_app;
REVOKE INSERT ON inventory_movements FROM uco_app;
