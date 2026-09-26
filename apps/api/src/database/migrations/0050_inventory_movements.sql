CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  item_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  delta numeric(20,3) NOT NULL CHECK (delta <> 0),
  source_type text NOT NULL CHECK (btrim(source_type) <> ''),
  source_id uuid NOT NULL,
  source_line_id uuid NOT NULL,
  effect_kind text NOT NULL CHECK (effect_kind IN ('INCREASE', 'DECREASE', 'TRANSFER_OUT', 'TRANSFER_IN')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movements_source_effect_key UNIQUE
    (organization_id, source_type, source_id, source_line_id, effect_kind),
  CONSTRAINT inventory_movements_branch_tenant_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movements_item_tenant_fk FOREIGN KEY (organization_id, item_id)
    REFERENCES catalog_items (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movements_stock_tenant_fk FOREIGN KEY (organization_id, branch_id, item_id)
    REFERENCES branch_stocks (organization_id, branch_id, item_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movements_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movements_effect_sign_check CHECK (
    (effect_kind IN ('INCREASE', 'TRANSFER_IN') AND delta > 0) OR
    (effect_kind IN ('DECREASE', 'TRANSFER_OUT') AND delta < 0)
  ),
  CONSTRAINT inventory_movements_transfer_source_check CHECK (
    (source_type = 'TRANSFER') = (effect_kind IN ('TRANSFER_OUT', 'TRANSFER_IN'))
  )
);

ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_movements_tenant_isolation ON inventory_movements
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, INSERT ON inventory_movements TO uco_app;

CREATE FUNCTION prevent_inventory_movement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER inventory_movements_immutable BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_movement_mutation();
