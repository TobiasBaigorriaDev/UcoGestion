CREATE TABLE cash_session_closures (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  cash_session_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_cash numeric(20,2) NOT NULL CHECK (expected_cash >= 0),
  counted_cash numeric(20,2) NOT NULL CHECK (counted_cash >= 0),
  difference numeric(20,2) NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  closed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_session_closures_session_unique UNIQUE (organization_id, cash_session_id),
  CONSTRAINT cash_session_closures_session_fk FOREIGN KEY (organization_id, cash_session_id)
    REFERENCES cash_sessions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT cash_session_closures_branch_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT cash_session_closures_difference_check CHECK (difference = counted_cash - expected_cash)
);

CREATE FUNCTION guard_cash_session_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_row cash_sessions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'cash session closure is immutable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO session_row FROM cash_sessions
    WHERE organization_id = NEW.organization_id AND id = NEW.cash_session_id;
  IF session_row.branch_id <> NEW.branch_id OR session_row.status NOT IN
      ('CLOSED', 'CLOSED_CONFLICT_RESOLVED', 'CLOSED_WITH_UNRECOVERED_DEVICE') OR
     session_row.currency_code <> NEW.currency_code OR
     session_row.expected_cash <> NEW.expected_cash THEN
    RAISE EXCEPTION 'cash session closure does not match final session' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_session_closure_guard BEFORE INSERT OR UPDATE OR DELETE ON cash_session_closures
  FOR EACH ROW EXECUTE FUNCTION guard_cash_session_closure();

ALTER TABLE cash_session_closures ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_session_closures_tenant_isolation ON cash_session_closures FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON cash_session_closures TO uco_app;
