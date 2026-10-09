ALTER TABLE cash_session_closures ADD COLUMN reason text,
  ADD COLUMN close_attempt_id uuid,
  ADD CONSTRAINT cash_closure_attempt_fk FOREIGN KEY (organization_id,close_attempt_id)
    REFERENCES cash_close_attempts(organization_id,id) ON DELETE RESTRICT;
CREATE TABLE cash_difference_reviews (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  cash_session_id uuid NOT NULL,
  closure_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status='PENDING_REVIEW'),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,cash_session_id),
  FOREIGN KEY (organization_id,cash_session_id) REFERENCES cash_sessions(organization_id,id) ON DELETE RESTRICT
);
ALTER TABLE cash_session_closures ADD CONSTRAINT cash_closure_tenant_id UNIQUE (organization_id,id);
ALTER TABLE cash_difference_reviews ADD CONSTRAINT cash_review_closure_fk
  FOREIGN KEY (organization_id,closure_id) REFERENCES cash_session_closures(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE cash_difference_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_difference_reviews_tenant ON cash_difference_reviews FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT,INSERT ON cash_difference_reviews TO uco_app;
CREATE TRIGGER cash_difference_reviews_immutable BEFORE UPDATE OR DELETE ON cash_difference_reviews
  FOR EACH ROW EXECUTE FUNCTION prevent_cash_session_transition_mutation();
