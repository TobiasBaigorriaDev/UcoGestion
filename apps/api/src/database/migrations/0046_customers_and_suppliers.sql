CREATE TABLE customers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  tax_id text,
  tax_id_norm text GENERATED ALWAYS AS (upper(btrim(tax_id))) STORED,
  contact text,
  address text,
  notes text,
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT customers_name_not_blank_check CHECK (btrim(name) <> ''),
  CONSTRAINT customers_tax_id_not_blank_check CHECK (tax_id IS NULL OR btrim(tax_id) <> ''),
  CONSTRAINT customers_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT customers_version_check CHECK (version > 0)
);

CREATE UNIQUE INDEX customers_organization_tax_id_norm_key
  ON customers (organization_id, tax_id_norm)
  WHERE tax_id_norm IS NOT NULL;

CREATE TABLE customer_history_references (
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  reference_type text NOT NULL CHECK (length(reference_type) BETWEEN 1 AND 80),
  source_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT customer_history_references_customer_tenant_fk
    FOREIGN KEY (organization_id, customer_id)
    REFERENCES customers (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT customer_history_references_source_key
    UNIQUE (organization_id, customer_id, reference_type, source_id)
);

CREATE TABLE suppliers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  tax_id text,
  tax_id_norm text GENERATED ALWAYS AS (upper(btrim(tax_id))) STORED,
  contact text,
  address text,
  notes text,
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT suppliers_name_not_blank_check CHECK (btrim(name) <> ''),
  CONSTRAINT suppliers_tax_id_not_blank_check CHECK (tax_id IS NULL OR btrim(tax_id) <> ''),
  CONSTRAINT suppliers_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT suppliers_version_check CHECK (version > 0)
);

CREATE UNIQUE INDEX suppliers_organization_tax_id_norm_key
  ON suppliers (organization_id, tax_id_norm)
  WHERE tax_id_norm IS NOT NULL;

CREATE TABLE supplier_history_references (
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  reference_type text NOT NULL CHECK (length(reference_type) BETWEEN 1 AND 80),
  source_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT supplier_history_references_supplier_tenant_fk
    FOREIGN KEY (organization_id, supplier_id)
    REFERENCES suppliers (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT supplier_history_references_source_key
    UNIQUE (organization_id, supplier_id, reference_type, source_id)
);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_history_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_history_references ENABLE ROW LEVEL SECURITY;

CREATE POLICY customers_tenant_isolation ON customers
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY customer_history_references_tenant_isolation ON customer_history_references
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY suppliers_tenant_isolation ON suppliers
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY supplier_history_references_tenant_isolation ON supplier_history_references
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, INSERT (id, organization_id, name, tax_id, contact, address, notes, status, version),
  UPDATE (name, tax_id, contact, address, notes, status, version, updated_at),
  DELETE ON customers TO uco_app;

GRANT SELECT, INSERT ON customer_history_references TO uco_app;

GRANT SELECT, INSERT (id, organization_id, name, tax_id, contact, address, notes, status, version),
  UPDATE (name, tax_id, contact, address, notes, status, version, updated_at),
  DELETE ON suppliers TO uco_app;

GRANT SELECT, INSERT ON supplier_history_references TO uco_app;

CREATE TRIGGER customer_history_references_immutable
  BEFORE UPDATE OR DELETE ON customer_history_references FOR EACH ROW
  EXECUTE FUNCTION prevent_organization_history_reference_mutation();

CREATE TRIGGER customer_history_references_mark_history
  AFTER INSERT ON customer_history_references FOR EACH ROW
  EXECUTE FUNCTION mark_organization_operational_history();

CREATE TRIGGER supplier_history_references_immutable
  BEFORE UPDATE OR DELETE ON supplier_history_references FOR EACH ROW
  EXECUTE FUNCTION prevent_organization_history_reference_mutation();

CREATE TRIGGER supplier_history_references_mark_history
  AFTER INSERT ON supplier_history_references FOR EACH ROW
  EXECUTE FUNCTION mark_organization_operational_history();
