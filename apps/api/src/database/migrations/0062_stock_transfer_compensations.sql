CREATE TABLE stock_transfer_compensations (
  organization_id uuid NOT NULL,
  original_transfer_id uuid NOT NULL,
  compensation_transfer_id uuid NOT NULL,
  PRIMARY KEY (organization_id, original_transfer_id),
  UNIQUE (organization_id, compensation_transfer_id),
  CHECK (original_transfer_id <> compensation_transfer_id),
  FOREIGN KEY (organization_id, original_transfer_id)
    REFERENCES stock_transfers (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, compensation_transfer_id)
    REFERENCES stock_transfers (organization_id, id) ON DELETE RESTRICT
);

ALTER TABLE stock_transfer_compensations ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_transfer_compensations_tenant_isolation ON stock_transfer_compensations FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT ON stock_transfer_compensations TO uco_app;
CREATE TRIGGER stock_transfer_compensations_immutable BEFORE UPDATE OR DELETE ON stock_transfer_compensations
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_adjustment_mutation();

CREATE FUNCTION inventory_api.link_transfer_compensation(
  p_organization_id uuid, p_original_id uuid, p_compensation_id uuid, p_actor_user_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_original stock_transfers%ROWTYPE;
  v_compensation stock_transfers%ROWTYPE;
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR p_actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory context mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_original FROM stock_transfers
    WHERE organization_id = p_organization_id AND id = p_original_id;
  SELECT * INTO v_compensation FROM stock_transfers
    WHERE organization_id = p_organization_id AND id = p_compensation_id;
  IF v_original.id IS NULL OR v_compensation.id IS NULL
    OR v_compensation.actor_user_id <> p_actor_user_id
    OR v_original.origin_branch_id <> v_compensation.destination_branch_id
    OR v_original.destination_branch_id <> v_compensation.origin_branch_id
    OR EXISTS (SELECT 1 FROM stock_transfer_compensations
      WHERE organization_id = p_organization_id AND compensation_transfer_id = p_original_id)
    OR EXISTS (
      SELECT item_id, quantity FROM stock_transfer_lines
        WHERE organization_id = p_organization_id AND transfer_id = p_original_id
      EXCEPT
      SELECT item_id, quantity FROM stock_transfer_lines
        WHERE organization_id = p_organization_id AND transfer_id = p_compensation_id
    ) OR EXISTS (
      SELECT item_id, quantity FROM stock_transfer_lines
        WHERE organization_id = p_organization_id AND transfer_id = p_compensation_id
      EXCEPT
      SELECT item_id, quantity FROM stock_transfer_lines
        WHERE organization_id = p_organization_id AND transfer_id = p_original_id
    ) THEN
    RAISE EXCEPTION 'invalid transfer compensation' USING ERRCODE = '22023';
  END IF;
  INSERT INTO stock_transfer_compensations (organization_id, original_transfer_id, compensation_transfer_id)
    VALUES (p_organization_id, p_original_id, p_compensation_id);
END;
$$;

REVOKE ALL ON FUNCTION inventory_api.link_transfer_compensation(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.link_transfer_compensation(uuid,uuid,uuid,uuid) TO uco_app;
