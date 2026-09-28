CREATE TABLE purchases (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  client_operation_id uuid NOT NULL,
  -- Initial state is immutable; current state is derived from payments and cancellations.
  confirmation_status text NOT NULL CHECK (confirmation_status IN ('PENDING_PAYMENT', 'PAID')),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  total numeric(20,2) NOT NULL CHECK (total >= 0),
  supplier_snapshot jsonb NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchases_tenant_id_key UNIQUE (organization_id, id),
  CONSTRAINT purchases_operation_key UNIQUE (organization_id, client_operation_id),
  CONSTRAINT purchases_branch_tenant_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchases_supplier_tenant_fk FOREIGN KEY (organization_id, supplier_id)
    REFERENCES suppliers(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE purchase_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  purchase_id uuid NOT NULL,
  item_id uuid NOT NULL,
  item_name text NOT NULL,
  item_type text NOT NULL,
  sku text,
  barcode text,
  unit text NOT NULL,
  category_id uuid,
  category_name text,
  track_inventory boolean NOT NULL,
  quantity numeric(20,3) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(20,2) NOT NULL CHECK (unit_cost >= 0),
  line_total numeric(20,2) NOT NULL CHECK (line_total >= 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT purchase_items_purchase_tenant_fk FOREIGN KEY (organization_id, purchase_id)
    REFERENCES purchases(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchase_items_item_tenant_fk FOREIGN KEY (organization_id, item_id)
    REFERENCES catalog_items(organization_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION prevent_purchase_foundation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'confirmed purchase history is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER purchases_immutable BEFORE UPDATE OR DELETE ON purchases
  FOR EACH ROW EXECUTE FUNCTION prevent_purchase_foundation_mutation();
CREATE TRIGGER purchase_items_immutable BEFORE UPDATE OR DELETE ON purchase_items
  FOR EACH ROW EXECUTE FUNCTION prevent_purchase_foundation_mutation();

ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchases_tenant_isolation ON purchases FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY purchase_items_tenant_isolation ON purchase_items FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON purchases, purchase_items TO uco_app;
