CREATE TABLE sales (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  cash_session_id uuid NOT NULL,
  device_id uuid NOT NULL,
  customer_id uuid,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  client_operation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'CONFIRMED' CHECK (status = 'CONFIRMED'),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric(20,2) NOT NULL CHECK (subtotal >= 0),
  discount numeric(20,2) NOT NULL CHECK (discount >= 0),
  total numeric(20,2) NOT NULL CHECK (total >= 0 AND total = subtotal - discount),
  receipt_snapshot jsonb NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT sales_organization_client_operation_key UNIQUE (organization_id, client_operation_id),
  CONSTRAINT sales_branch_tenant_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_session_device_fk FOREIGN KEY (organization_id, branch_id, cash_session_id, device_id)
    REFERENCES cash_sessions (organization_id, branch_id, id, device_id) ON DELETE RESTRICT,
  CONSTRAINT sales_customer_tenant_fk FOREIGN KEY (organization_id, customer_id)
    REFERENCES customers (organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE sale_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  item_id uuid NOT NULL,
  item_name text NOT NULL,
  item_type text NOT NULL,
  sku text,
  barcode text,
  unit text NOT NULL,
  category_id uuid,
  category_name text,
  quantity numeric(20,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,2) NOT NULL CHECK (unit_price >= 0),
  price_version bigint NOT NULL CHECK (price_version > 0),
  line_total numeric(20,2) NOT NULL CHECK (line_total >= 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT sale_items_sale_tenant_fk FOREIGN KEY (organization_id, sale_id)
    REFERENCES sales (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT sale_items_item_tenant_fk FOREIGN KEY (organization_id, item_id)
    REFERENCES catalog_items (organization_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION prevent_sale_foundation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'confirmed sale history is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER sales_immutable BEFORE UPDATE OR DELETE ON sales
  FOR EACH ROW EXECUTE FUNCTION prevent_sale_foundation_mutation();
CREATE TRIGGER sale_items_immutable BEFORE UPDATE OR DELETE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION prevent_sale_foundation_mutation();

ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_tenant_isolation ON sales FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY sale_items_tenant_isolation ON sale_items FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON sales, sale_items TO uco_app;
