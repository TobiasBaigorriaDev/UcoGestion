ALTER TABLE cash_registers
  ADD COLUMN name_norm text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT cash_registers_name_not_blank_check CHECK (btrim(name) <> ''),
  ADD CONSTRAINT cash_registers_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  ADD CONSTRAINT cash_registers_version_check CHECK (version > 0);

CREATE UNIQUE INDEX cash_registers_branch_name_norm_key
  ON cash_registers (organization_id, branch_id, name_norm);

GRANT INSERT (id, organization_id, branch_id, name, status, version) ON cash_registers TO uco_app;
GRANT UPDATE (name, status, version) ON cash_registers TO uco_app;
