CREATE TABLE stock_transfers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  origin_branch_id uuid NOT NULL,
  destination_branch_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (origin_branch_id <> destination_branch_id),
  CONSTRAINT stock_transfers_origin_fk FOREIGN KEY (organization_id, origin_branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_transfers_destination_fk FOREIGN KEY (organization_id, destination_branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE stock_transfer_lines (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(20,3) NOT NULL CHECK (quantity > 0),
  UNIQUE (organization_id, transfer_id, item_id),
  CONSTRAINT stock_transfer_lines_transfer_fk FOREIGN KEY (organization_id, transfer_id)
    REFERENCES stock_transfers (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_transfer_lines_item_fk FOREIGN KEY (organization_id, item_id)
    REFERENCES catalog_items (organization_id, id) ON DELETE RESTRICT
);

ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_transfers_tenant_isolation ON stock_transfers FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE stock_transfer_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_transfer_lines_tenant_isolation ON stock_transfer_lines FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT ON stock_transfers, stock_transfer_lines TO uco_app;
CREATE TRIGGER stock_transfers_immutable BEFORE UPDATE OR DELETE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_adjustment_mutation();
CREATE TRIGGER stock_transfer_lines_immutable BEFORE UPDATE OR DELETE ON stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_adjustment_mutation();

CREATE FUNCTION inventory_api.apply_transfer(
  p_id uuid, p_organization_id uuid, p_origin_id uuid, p_destination_id uuid,
  p_actor_user_id uuid, p_line_ids uuid[], p_item_ids uuid[], p_quantities numeric[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_membership_id uuid;
  v_role text;
  v_unit text;
  v_item_id uuid;
  v_branch_id uuid;
  v_insufficient boolean;
  v_index integer;
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR p_actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory context mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_origin_id = p_destination_id OR p_origin_id IS NULL OR p_destination_id IS NULL
    OR coalesce(array_length(p_item_ids, 1), 0) = 0
    OR array_length(p_item_ids, 1) <> array_length(p_line_ids, 1)
    OR array_length(p_item_ids, 1) <> array_length(p_quantities, 1)
    OR EXISTS (SELECT 1 FROM unnest(p_item_ids) AS item_id GROUP BY item_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'invalid transfer lines or branches' USING ERRCODE = '22023';
  END IF;
  SELECT id, role INTO v_membership_id, v_role FROM memberships
    WHERE organization_id = p_organization_id AND user_id = p_actor_user_id
      AND status = 'ACTIVE' AND revoked_at IS NULL;
  IF v_role NOT IN ('OWNER', 'ADMIN', 'EMPLOYEE') OR v_role IS NULL THEN
    RAISE EXCEPTION 'transfer forbidden' USING ERRCODE = '42501';
  END IF;
  FOR v_branch_id IN SELECT unnest(ARRAY[p_origin_id, p_destination_id]) ORDER BY 1 LOOP
    IF NOT EXISTS (SELECT 1 FROM branches b WHERE b.organization_id = p_organization_id
      AND b.id = v_branch_id AND b.status = 'ACTIVE' AND EXISTS (
        SELECT 1 FROM effective_membership_branch_scope s
        WHERE s.organization_id = b.organization_id AND s.branch_id = b.id
          AND s.membership_id = v_membership_id)) THEN
      RAISE EXCEPTION 'transfer branch forbidden' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  FOR v_item_id IN SELECT unnest(p_item_ids) ORDER BY 1 LOOP
    SELECT base_unit INTO v_unit FROM catalog_items WHERE organization_id = p_organization_id
      AND id = v_item_id AND type = 'PRODUCT' AND track_inventory AND status = 'ACTIVE';
    IF v_unit IS NULL THEN
      RAISE EXCEPTION 'transfer item unavailable' USING ERRCODE = '23503';
    END IF;
    v_index := array_position(p_item_ids, v_item_id);
    IF p_quantities[v_index] IS NULL OR p_quantities[v_index] <= 0
      OR scale(p_quantities[v_index]) > 3 OR p_quantities[v_index] > 99999999999999999.999
      OR (v_unit = 'UNIT' AND p_quantities[v_index] <> trunc(p_quantities[v_index])) THEN
      RAISE EXCEPTION 'invalid transfer quantity' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOR v_branch_id, v_item_id IN
    SELECT branch_id, item_id FROM
      unnest(ARRAY[p_origin_id, p_destination_id]) AS b(branch_id)
      CROSS JOIN unnest(p_item_ids) AS i(item_id)
    ORDER BY branch_id, item_id
  LOOP
    v_index := array_position(p_item_ids, v_item_id);
    SELECT inventory_api.lock_transfer_stock(p_organization_id, v_branch_id,
      v_item_id, p_actor_user_id, p_quantities[v_index]) INTO v_insufficient;
    IF v_branch_id = p_origin_id AND v_insufficient THEN
      RAISE EXCEPTION 'insufficient transfer stock' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  SELECT id, role INTO v_membership_id, v_role FROM memberships
    WHERE organization_id = p_organization_id AND user_id = p_actor_user_id
      AND status = 'ACTIVE' AND revoked_at IS NULL;
  IF v_role NOT IN ('OWNER', 'ADMIN', 'EMPLOYEE') OR v_role IS NULL THEN
    RAISE EXCEPTION 'transfer forbidden' USING ERRCODE = '42501';
  END IF;
  FOR v_branch_id IN SELECT unnest(ARRAY[p_origin_id, p_destination_id]) ORDER BY 1 LOOP
    IF NOT EXISTS (SELECT 1 FROM branches b WHERE b.organization_id = p_organization_id
      AND b.id = v_branch_id AND b.status = 'ACTIVE' AND EXISTS (
        SELECT 1 FROM effective_membership_branch_scope s
        WHERE s.organization_id = b.organization_id AND s.branch_id = b.id
          AND s.membership_id = v_membership_id)) THEN
      RAISE EXCEPTION 'transfer branch forbidden' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  INSERT INTO stock_transfers (id, organization_id, origin_branch_id, destination_branch_id, actor_user_id)
    VALUES (p_id, p_organization_id, p_origin_id, p_destination_id, p_actor_user_id);
  FOR v_index IN 1..array_length(p_item_ids, 1) LOOP
    INSERT INTO stock_transfer_lines (id, organization_id, transfer_id, item_id, quantity)
      VALUES (p_line_ids[v_index], p_organization_id, p_id, p_item_ids[v_index], p_quantities[v_index]);
    INSERT INTO inventory_movements (id, organization_id, branch_id, item_id, actor_user_id,
      delta, source_type, source_id, source_line_id, effect_kind) VALUES
      (gen_random_uuid(), p_organization_id, p_origin_id, p_item_ids[v_index], p_actor_user_id,
        -p_quantities[v_index], 'TRANSFER', p_id, p_line_ids[v_index], 'TRANSFER_OUT'),
      (gen_random_uuid(), p_organization_id, p_destination_id, p_item_ids[v_index], p_actor_user_id,
        p_quantities[v_index], 'TRANSFER', p_id, p_line_ids[v_index], 'TRANSFER_IN');
    UPDATE branch_stocks SET quantity = quantity - p_quantities[v_index], version = version + 1
      WHERE organization_id = p_organization_id AND branch_id = p_origin_id AND item_id = p_item_ids[v_index];
    UPDATE branch_stocks SET quantity = quantity + p_quantities[v_index], version = version + 1
      WHERE organization_id = p_organization_id AND branch_id = p_destination_id AND item_id = p_item_ids[v_index];
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION inventory_api.apply_transfer(uuid,uuid,uuid,uuid,uuid,uuid[],uuid[],numeric[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.apply_transfer(uuid,uuid,uuid,uuid,uuid,uuid[],uuid[],numeric[]) TO uco_app;
