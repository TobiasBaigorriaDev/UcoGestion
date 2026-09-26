ALTER TABLE cash_sessions
  ADD CONSTRAINT cash_sessions_organization_branch_id_key UNIQUE (organization_id, branch_id, id);

CREATE TABLE cash_movements (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  cash_session_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL,
  delta numeric(20,2) NOT NULL CHECK (delta <> 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  source_type text NOT NULL CHECK (btrim(source_type) <> ''),
  source_id uuid NOT NULL,
  effect_kind text NOT NULL CHECK (effect_kind IN ('IN', 'OUT')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_movements_source_effect_key UNIQUE
    (organization_id, source_type, source_id, effect_kind),
  CONSTRAINT cash_movements_session_branch_fk FOREIGN KEY (organization_id, branch_id, cash_session_id)
    REFERENCES cash_sessions (organization_id, branch_id, id) ON DELETE RESTRICT,
  CONSTRAINT cash_movements_device_branch_fk FOREIGN KEY (organization_id, branch_id, device_id)
    REFERENCES devices (organization_id, branch_id, id) ON DELETE RESTRICT,
  CONSTRAINT cash_movements_effect_sign_check CHECK (
    (effect_kind = 'IN' AND delta > 0) OR (effect_kind = 'OUT' AND delta < 0)
  )
);

CREATE FUNCTION apply_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_expected numeric(20,2);
DECLARE session_currency text;
DECLARE session_status text;
BEGIN
  SELECT expected_cash, currency_code, status INTO current_expected, session_currency, session_status FROM cash_sessions
    WHERE organization_id = NEW.organization_id AND branch_id = NEW.branch_id
      AND id = NEW.cash_session_id FOR UPDATE;
  IF current_expected IS NULL OR current_expected + NEW.delta < 0 THEN
    RAISE EXCEPTION 'insufficient expected cash or missing session' USING ERRCODE = '23514';
  END IF;
  IF NEW.currency_code <> session_currency THEN
    RAISE EXCEPTION 'cash movement currency mismatch' USING ERRCODE = '23514';
  END IF;
  IF session_status NOT IN ('OPEN', 'CONFLICTED') THEN
    RAISE EXCEPTION 'cash session does not accept movements' USING ERRCODE = '23514';
  END IF;
  UPDATE cash_sessions SET expected_cash = current_expected + NEW.delta
    WHERE organization_id = NEW.organization_id AND id = NEW.cash_session_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_movement_projection AFTER INSERT ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION apply_cash_movement();

CREATE FUNCTION prevent_cash_movement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cash movements are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER cash_movements_immutable BEFORE UPDATE OR DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION prevent_cash_movement_mutation();

ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_movements_tenant_isolation ON cash_movements FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT ON cash_movements TO uco_app;
