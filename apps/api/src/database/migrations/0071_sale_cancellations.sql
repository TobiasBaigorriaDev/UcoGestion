ALTER TABLE sales ADD CONSTRAINT sales_tenant_branch_id_unique
  UNIQUE (organization_id, branch_id, id);

CREATE TABLE sale_cancellations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  cancelled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sale_cancellations_sale_unique UNIQUE (organization_id, sale_id),
  CONSTRAINT sale_cancellations_tenant_id_unique UNIQUE (organization_id, id),
  CONSTRAINT sale_cancellations_sale_fk FOREIGN KEY (organization_id, branch_id, sale_id)
    REFERENCES sales (organization_id, branch_id, id) ON DELETE RESTRICT,
  CONSTRAINT sale_cancellations_branch_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER sale_cancellations_immutable BEFORE UPDATE OR DELETE ON sale_cancellations
  FOR EACH ROW EXECUTE FUNCTION prevent_sale_foundation_mutation();
ALTER TABLE sale_cancellations ENABLE ROW LEVEL SECURITY;
CREATE POLICY sale_cancellations_tenant_isolation ON sale_cancellations FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON sale_cancellations TO uco_app;
