CREATE TABLE cash_late_reviews (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  cash_session_id uuid NOT NULL,
  through_operation_id uuid NOT NULL,
  reviewer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note text NOT NULL CHECK (length(note)<=2000),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,cash_session_id,through_operation_id),
  FOREIGN KEY (organization_id,cash_session_id) REFERENCES cash_sessions(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,through_operation_id) REFERENCES cash_late_recoveries(organization_id,operation_id) ON DELETE RESTRICT
);
ALTER TABLE cash_late_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_late_reviews_tenant ON cash_late_reviews FOR ALL TO uco_app
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT,INSERT ON cash_late_reviews TO uco_app;
CREATE TRIGGER cash_late_reviews_immutable BEFORE UPDATE OR DELETE ON cash_late_reviews
  FOR EACH ROW EXECUTE FUNCTION prevent_cash_session_transition_mutation();
