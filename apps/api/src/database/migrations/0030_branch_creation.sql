ALTER TABLE branches
  ADD CONSTRAINT branches_name_not_blank_check CHECK (btrim(name) <> '');

GRANT INSERT (id, organization_id, name, status, version) ON branches TO uco_app;
