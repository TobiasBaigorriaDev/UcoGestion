CREATE TABLE cash_late_recoveries (
  organization_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  cash_session_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  marker text NOT NULL DEFAULT 'LATE_RECOVERED_OPERATIONS' CHECK (marker='LATE_RECOVERED_OPERATIONS'),
  expected_cash_known numeric(20,2) NOT NULL CHECK (expected_cash_known>=0),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,operation_id),
  FOREIGN KEY (organization_id,operation_id) REFERENCES sync_operations(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,cash_session_id) REFERENCES cash_sessions(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,sale_id) REFERENCES sales(organization_id,id) ON DELETE RESTRICT
);
ALTER TABLE cash_late_recoveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_late_recoveries_tenant ON cash_late_recoveries FOR ALL TO uco_app
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT,INSERT ON cash_late_recoveries TO uco_app;
CREATE TRIGGER cash_late_recoveries_immutable BEFORE UPDATE OR DELETE ON cash_late_recoveries
  FOR EACH ROW EXECUTE FUNCTION prevent_cash_session_transition_mutation();

CREATE OR REPLACE FUNCTION apply_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_expected numeric(20,2); session_currency text; session_status text;
BEGIN
  SELECT expected_cash,currency_code,status INTO current_expected,session_currency,session_status FROM cash_sessions
    WHERE organization_id=NEW.organization_id AND branch_id=NEW.branch_id AND id=NEW.cash_session_id FOR UPDATE;
  IF current_expected IS NULL OR current_expected+NEW.delta<0 THEN
    RAISE EXCEPTION 'insufficient expected cash or missing session' USING ERRCODE='23514';
  END IF;
  IF NEW.currency_code<>session_currency THEN RAISE EXCEPTION 'cash movement currency mismatch' USING ERRCODE='23514'; END IF;
  IF session_status NOT IN ('OPEN','CONFLICTED') AND NOT
    (session_status='CLOSED_WITH_UNRECOVERED_DEVICE' AND NEW.source_type='SALE' AND NEW.effect_kind='IN' AND EXISTS
      (SELECT 1 FROM sales s JOIN sync_operations op ON op.organization_id=s.organization_id AND op.id=s.offline_operation_id
       JOIN cash_exceptional_closures c ON c.organization_id=s.organization_id AND c.cash_session_id=s.cash_session_id
       WHERE s.organization_id=NEW.organization_id AND s.id=NEW.source_id AND s.cash_session_id=NEW.cash_session_id
       AND op.session_id=NEW.cash_session_id AND op.device_id=NEW.device_id AND s.device_id=NEW.device_id
       AND s.actor_user_id=NEW.actor_user_id AND op.kind='sale-confirm' AND op.status IN ('PENDING','ACKED'))) THEN
    RAISE EXCEPTION 'cash session does not accept movements' USING ERRCODE='23514';
  END IF;
  UPDATE cash_sessions SET expected_cash=current_expected+NEW.delta WHERE organization_id=NEW.organization_id AND id=NEW.cash_session_id;
  RETURN NEW;
END;
$$;
