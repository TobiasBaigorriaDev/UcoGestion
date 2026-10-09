CREATE TABLE cash_close_attempts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  cash_session_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  checkpoint jsonb NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, cash_session_id)
    REFERENCES cash_sessions(organization_id, id) ON DELETE RESTRICT
);
ALTER TABLE cash_close_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_close_attempts_tenant ON cash_close_attempts FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON cash_close_attempts TO uco_app;
CREATE TRIGGER cash_close_attempts_immutable BEFORE UPDATE OR DELETE ON cash_close_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_cash_session_transition_mutation();

ALTER TABLE cash_session_state_transitions ADD COLUMN close_attempt_id uuid,
  ADD CONSTRAINT cash_transition_close_attempt_fk FOREIGN KEY (organization_id, close_attempt_id)
    REFERENCES cash_close_attempts(organization_id, id) ON DELETE RESTRICT;
