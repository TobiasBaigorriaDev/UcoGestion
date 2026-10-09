CREATE TABLE cash_exceptional_closures (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  cash_session_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  snapshot jsonb NOT NULL CHECK (snapshot ?& ARRAY['version','organizationId','cashSessionId','deviceId','currencyCode','reason',
    'lastContactAt','expectedCashKnown','countedCash','differenceObserved','operationalDataCompleteness','lateData','operationsReceived']
    AND snapshot->>'version'='1' AND snapshot->>'operationalDataCompleteness'='UNKNOWN' AND snapshot->>'lateData'='NONE'
    AND length(trim(snapshot->>'reason')) BETWEEN 1 AND 2000 AND (snapshot->>'expectedCashKnown')::numeric>=0),
  closed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,cash_session_id),
  FOREIGN KEY (organization_id,cash_session_id) REFERENCES cash_sessions(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,branch_id) REFERENCES branches(organization_id,id) ON DELETE RESTRICT
);
ALTER TABLE cash_exceptional_closures ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_exceptional_closures_tenant ON cash_exceptional_closures FOR ALL TO uco_app
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT,INSERT ON cash_exceptional_closures TO uco_app;
GRANT UPDATE (completeness) ON cash_sessions TO uco_app;

CREATE OR REPLACE FUNCTION guard_cash_session_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR pg_trigger_depth()<2 OR
    (to_jsonb(NEW)-'status'-'expected_cash'-'completeness')<>(to_jsonb(OLD)-'status'-'expected_cash'-'completeness') OR
    (NEW.completeness IS DISTINCT FROM OLD.completeness AND
      NOT (OLD.completeness='COMPLETE' AND NEW.completeness='UNKNOWN' AND NEW.status='CLOSED_WITH_UNRECOVERED_DEVICE')) THEN
    RAISE EXCEPTION 'cash session history is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_cash_exceptional_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_row cash_sessions%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'exceptional closure is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO session_row FROM cash_sessions WHERE organization_id=NEW.organization_id AND id=NEW.cash_session_id;
  IF session_row.status IS DISTINCT FROM 'CLOSED_WITH_UNRECOVERED_DEVICE' OR session_row.branch_id<>NEW.branch_id OR
    NEW.snapshot->>'organizationId'<>NEW.organization_id::text OR NEW.snapshot->>'cashSessionId'<>NEW.cash_session_id::text OR
    NEW.snapshot->>'deviceId'<>session_row.device_id::text OR NEW.snapshot->>'currencyCode'<>session_row.currency_code OR
    (NEW.snapshot->>'expectedCashKnown')::numeric<>session_row.expected_cash THEN
    RAISE EXCEPTION 'exceptional snapshot does not match final session' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_exceptional_closure_guard BEFORE INSERT OR UPDATE OR DELETE ON cash_exceptional_closures
  FOR EACH ROW EXECUTE FUNCTION guard_cash_exceptional_closure();
CREATE FUNCTION apply_cash_exceptional_completeness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE cash_sessions SET completeness='UNKNOWN' WHERE organization_id=NEW.organization_id AND id=NEW.cash_session_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_exceptional_completeness AFTER INSERT ON cash_exceptional_closures
  FOR EACH ROW EXECUTE FUNCTION apply_cash_exceptional_completeness();

CREATE FUNCTION require_cash_exceptional_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.to_status='CLOSED_WITH_UNRECOVERED_DEVICE' AND NOT EXISTS
    (SELECT 1 FROM cash_exceptional_closures c JOIN cash_sessions s ON s.organization_id=c.organization_id AND s.id=c.cash_session_id
     WHERE c.organization_id=NEW.organization_id AND c.cash_session_id=NEW.cash_session_id AND s.completeness='UNKNOWN') THEN
    RAISE EXCEPTION 'exceptional transition requires immutable snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER cash_exceptional_snapshot_required AFTER INSERT ON cash_session_state_transitions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_exceptional_snapshot();
