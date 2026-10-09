CREATE TABLE cash_difference_review_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  review_id uuid NOT NULL,
  reviewer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('REVIEW','SELF_REVIEW')),
  note text NOT NULL CHECK (length(note)<=2000 AND (mode<>'SELF_REVIEW' OR length(trim(note))>0)),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,review_id),
  FOREIGN KEY (organization_id,review_id) REFERENCES cash_difference_reviews(organization_id,id) ON DELETE RESTRICT
);
ALTER TABLE cash_difference_review_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_difference_review_events_tenant ON cash_difference_review_events FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT,INSERT ON cash_difference_review_events TO uco_app;
CREATE TRIGGER cash_difference_review_events_immutable BEFORE UPDATE OR DELETE ON cash_difference_review_events
  FOR EACH ROW EXECUTE FUNCTION prevent_cash_session_transition_mutation();
