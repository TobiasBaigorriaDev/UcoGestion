CREATE TABLE cash_sessions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  cash_register_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL,
  origin text NOT NULL CHECK (origin IN ('ONLINE', 'OFFLINE')),
  status text NOT NULL CHECK (status IN ('OPEN', 'CLOSING', 'CONFLICTED', 'CLOSED',
    'CLOSED_CONFLICT_RESOLVED', 'CLOSED_WITH_UNRECOVERED_DEVICE')),
  opening_cash numeric(20,2) NOT NULL CHECK (opening_cash >= 0),
  expected_cash numeric(20,2) NOT NULL CHECK (expected_cash >= 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  server_sync_seq bigint NOT NULL DEFAULT 0 CHECK (server_sync_seq >= 0),
  completeness text NOT NULL DEFAULT 'COMPLETE' CHECK (completeness IN ('COMPLETE', 'UNKNOWN')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_sessions_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT cash_sessions_branch_tenant_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT cash_sessions_register_tenant_fk FOREIGN KEY (organization_id, cash_register_id)
    REFERENCES cash_registers (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT cash_sessions_device_branch_fk FOREIGN KEY (organization_id, branch_id, device_id)
    REFERENCES devices (organization_id, branch_id, id) ON DELETE RESTRICT,
  CONSTRAINT cash_sessions_origin_status_check CHECK (origin <> 'ONLINE' OR status <> 'CONFLICTED')
);

CREATE UNIQUE INDEX cash_sessions_one_normal_active_per_register
  ON cash_sessions (organization_id, cash_register_id)
  WHERE status IN ('OPEN', 'CLOSING');

CREATE FUNCTION guard_cash_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expected_cash <> NEW.opening_cash OR
     (NEW.origin = 'ONLINE' AND NEW.status <> 'OPEN') OR
     (NEW.origin = 'OFFLINE' AND NEW.status NOT IN ('OPEN', 'CONFLICTED')) THEN
    RAISE EXCEPTION 'invalid initial cash session state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_session_insert_guard BEFORE INSERT ON cash_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_cash_session_insert();

CREATE TABLE cash_session_state_transitions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  cash_session_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  from_status text NOT NULL,
  to_status text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_session_transitions_session_fk FOREIGN KEY (organization_id, cash_session_id)
    REFERENCES cash_sessions (organization_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION guard_cash_session_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR pg_trigger_depth() < 2 OR
     (to_jsonb(NEW) - 'status' - 'expected_cash') <> (to_jsonb(OLD) - 'status' - 'expected_cash') THEN
    RAISE EXCEPTION 'cash session history is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_session_update_guard BEFORE UPDATE OR DELETE ON cash_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_cash_session_update();

CREATE FUNCTION apply_cash_session_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status text;
BEGIN
  SELECT status INTO current_status FROM cash_sessions
    WHERE organization_id = NEW.organization_id AND id = NEW.cash_session_id FOR UPDATE;
  IF current_status IS NULL OR current_status <> NEW.from_status THEN
    RAISE EXCEPTION 'cash session state conflict' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (NEW.from_status = 'OPEN' AND NEW.to_status IN ('CLOSING', 'CLOSED_WITH_UNRECOVERED_DEVICE')) OR
    (NEW.from_status = 'CLOSING' AND NEW.to_status IN ('OPEN', 'CLOSED', 'CLOSED_WITH_UNRECOVERED_DEVICE')) OR
    (NEW.from_status = 'CONFLICTED' AND NEW.to_status IN ('CLOSED_CONFLICT_RESOLVED', 'CLOSED_WITH_UNRECOVERED_DEVICE'))
  ) THEN
    RAISE EXCEPTION 'invalid cash session transition' USING ERRCODE = '23514';
  END IF;
  UPDATE cash_sessions SET status = NEW.to_status
    WHERE organization_id = NEW.organization_id AND id = NEW.cash_session_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_session_transition_apply AFTER INSERT ON cash_session_state_transitions
  FOR EACH ROW EXECUTE FUNCTION apply_cash_session_transition();

CREATE FUNCTION prevent_cash_session_transition_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cash session transitions are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER cash_session_transitions_immutable BEFORE UPDATE OR DELETE ON cash_session_state_transitions
  FOR EACH ROW EXECUTE FUNCTION prevent_cash_session_transition_mutation();

ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_session_state_transitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_sessions_tenant_isolation ON cash_sessions FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY cash_session_transitions_tenant_isolation ON cash_session_state_transitions FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE (status, expected_cash) ON cash_sessions TO uco_app;
GRANT SELECT, INSERT ON cash_session_state_transitions TO uco_app;
