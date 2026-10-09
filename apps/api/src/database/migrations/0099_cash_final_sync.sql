ALTER TABLE cash_session_state_transitions ADD COLUMN transition_sequence bigint GENERATED ALWAYS AS IDENTITY;
CREATE TABLE cash_final_syncs (
  organization_id uuid NOT NULL,
  close_attempt_id uuid NOT NULL,
  expected_cash numeric(20,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,close_attempt_id),
  FOREIGN KEY (organization_id,close_attempt_id) REFERENCES cash_close_attempts(organization_id,id) ON DELETE RESTRICT
);
ALTER TABLE cash_final_syncs ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_final_syncs_tenant ON cash_final_syncs FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT,INSERT ON cash_final_syncs TO uco_app;
CREATE TRIGGER cash_final_syncs_immutable BEFORE UPDATE OR DELETE ON cash_final_syncs
  FOR EACH ROW EXECUTE FUNCTION prevent_cash_session_transition_mutation();
