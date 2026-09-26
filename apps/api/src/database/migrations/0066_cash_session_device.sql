ALTER TABLE cash_sessions ADD CONSTRAINT cash_sessions_device_identity_key
  UNIQUE (organization_id, branch_id, id, device_id);

ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_session_device_fk
  FOREIGN KEY (organization_id, branch_id, cash_session_id, device_id)
  REFERENCES cash_sessions (organization_id, branch_id, id, device_id) ON DELETE RESTRICT;
