ALTER TABLE cash_movements ADD COLUMN reason text;
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_reason_check
  CHECK (reason IS NULL OR (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 2000));
