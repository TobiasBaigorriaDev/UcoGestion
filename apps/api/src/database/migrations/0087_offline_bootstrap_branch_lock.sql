-- Row-level SHARE locks require UPDATE privilege on at least one column.
-- Keep branch mutation authority limited to status; RLS still isolates tenants.
GRANT UPDATE (status) ON branches TO uco_app;
