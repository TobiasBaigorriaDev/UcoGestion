CREATE TABLE branch_stocks (
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(20,3) NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (organization_id, branch_id, item_id),
  CONSTRAINT branch_stocks_branch_tenant_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT branch_stocks_item_tenant_fk FOREIGN KEY (organization_id, item_id)
    REFERENCES catalog_items (organization_id, id) ON DELETE RESTRICT
);

ALTER TABLE branch_stocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_stocks_tenant_isolation ON branch_stocks
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT ON branch_stocks TO uco_app;
