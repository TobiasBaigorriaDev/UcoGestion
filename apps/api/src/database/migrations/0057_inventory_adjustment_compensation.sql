ALTER TABLE inventory_adjustments ADD CONSTRAINT inventory_adjustments_tenant_identity
  UNIQUE (organization_id, id);

CREATE TABLE inventory_adjustment_compensations (
  organization_id uuid NOT NULL,
  original_adjustment_id uuid NOT NULL,
  compensation_adjustment_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, original_adjustment_id),
  UNIQUE (organization_id, compensation_adjustment_id),
  CONSTRAINT inventory_compensation_original_fk FOREIGN KEY (organization_id, original_adjustment_id)
    REFERENCES inventory_adjustments (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_compensation_new_fk FOREIGN KEY (organization_id, compensation_adjustment_id)
    REFERENCES inventory_adjustments (organization_id, id) ON DELETE RESTRICT,
  CHECK (original_adjustment_id <> compensation_adjustment_id)
);

ALTER TABLE inventory_adjustment_compensations ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_adjustment_compensations_tenant_isolation ON inventory_adjustment_compensations
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT ON inventory_adjustment_compensations TO uco_app;

CREATE TRIGGER inventory_adjustment_compensations_immutable
  BEFORE UPDATE OR DELETE ON inventory_adjustment_compensations
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_adjustment_mutation();

CREATE FUNCTION inventory_api.link_compensation(
  p_organization_id uuid, p_original_id uuid, p_compensation_id uuid, p_actor_user_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_original inventory_adjustments%ROWTYPE;
  v_compensation inventory_adjustments%ROWTYPE;
  v_role text;
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR p_actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory context mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_original FROM inventory_adjustments
    WHERE organization_id = p_organization_id AND id = p_original_id;
  SELECT * INTO v_compensation FROM inventory_adjustments
    WHERE organization_id = p_organization_id AND id = p_compensation_id;
  IF v_original.id IS NULL OR v_compensation.id IS NULL
    OR v_compensation.actor_user_id <> p_actor_user_id
    OR v_original.branch_id <> v_compensation.branch_id
    OR v_original.item_id <> v_compensation.item_id
    OR v_original.quantity <> v_compensation.quantity
    OR v_original.direction = v_compensation.direction
    OR v_compensation.reason <> 'CORRECCION' THEN
    RAISE EXCEPTION 'invalid inventory compensation' USING ERRCODE = '22023';
  END IF;
  SELECT role INTO v_role FROM memberships WHERE organization_id = p_organization_id
    AND user_id = p_actor_user_id AND status = 'ACTIVE' AND revoked_at IS NULL;
  IF v_role NOT IN ('OWNER', 'ADMIN', 'EMPLOYEE') OR v_role IS NULL
    OR (v_role <> 'OWNER' AND NOT EXISTS (
      SELECT 1 FROM membership_branches mb JOIN memberships m
        ON m.organization_id = mb.organization_id AND m.id = mb.membership_id
      WHERE m.organization_id = p_organization_id AND m.user_id = p_actor_user_id
        AND mb.branch_id = v_compensation.branch_id)) THEN
    RAISE EXCEPTION 'inventory compensation forbidden' USING ERRCODE = '42501';
  END IF;
  INSERT INTO inventory_adjustment_compensations
    (organization_id, original_adjustment_id, compensation_adjustment_id)
    VALUES (p_organization_id, p_original_id, p_compensation_id);
END;
$$;

REVOKE ALL ON FUNCTION inventory_api.link_compensation(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.link_compensation(uuid,uuid,uuid,uuid) TO uco_app;
