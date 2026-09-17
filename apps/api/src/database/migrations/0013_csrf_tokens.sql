ALTER TABLE auth_sessions ADD COLUMN csrf_token text;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_csrf_token_check CHECK (
  csrf_token IS NULL OR csrf_token ~ '^[A-Za-z0-9_-]{43}$'
);

GRANT SELECT (csrf_token) ON auth_sessions TO uco_app;
GRANT INSERT (csrf_token) ON auth_sessions TO uco_app;
GRANT UPDATE (csrf_token) ON auth_sessions TO uco_app;
