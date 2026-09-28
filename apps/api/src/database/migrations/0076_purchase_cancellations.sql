ALTER TABLE purchases ADD CONSTRAINT purchases_tenant_branch_id_key
  UNIQUE (organization_id, branch_id, id);

CREATE TABLE purchase_cancellations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  purchase_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  cancelled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_cancellations_purchase_unique UNIQUE (organization_id, purchase_id),
  CONSTRAINT purchase_cancellations_tenant_purchase_id_key UNIQUE (organization_id, purchase_id, id),
  CONSTRAINT purchase_cancellations_purchase_fk FOREIGN KEY (organization_id, branch_id, purchase_id)
    REFERENCES purchases (organization_id, branch_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER purchase_cancellations_immutable BEFORE UPDATE OR DELETE ON purchase_cancellations
  FOR EACH ROW EXECUTE FUNCTION prevent_purchase_foundation_mutation();
ALTER TABLE purchase_cancellations ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_cancellations_tenant_isolation ON purchase_cancellations FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON purchase_cancellations TO uco_app;
