-- Legacy operations have no device declaration: preserve that absence instead
-- of inventing occurred_at from a server timestamp.
ALTER TABLE sync_operations ADD COLUMN occurred_at timestamptz,
  ADD COLUMN received_at timestamptz;
-- The migrator holds this migration in one transaction. Temporarily suspend
-- only the definitive-state guard while adding reception metadata to old rows.
ALTER TABLE sync_operations DISABLE TRIGGER sync_operations_no_reversal;
UPDATE sync_operations SET received_at = created_at;
ALTER TABLE sync_operations ENABLE TRIGGER sync_operations_no_reversal;
ALTER TABLE sync_operations ALTER COLUMN received_at SET NOT NULL,
  ALTER COLUMN received_at SET DEFAULT clock_timestamp();

CREATE FUNCTION protect_sync_operation_times()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.occurred_at IS NULL THEN
      RAISE EXCEPTION 'device occurrence timestamp is required' USING ERRCODE = '23502';
    END IF;
    NEW.received_at := clock_timestamp();
  ELSIF NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR
    NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'offline operation timestamps are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION protect_sync_operation_times() FROM PUBLIC;
CREATE TRIGGER sync_operations_times BEFORE INSERT OR UPDATE ON sync_operations
  FOR EACH ROW EXECUTE FUNCTION protect_sync_operation_times();
