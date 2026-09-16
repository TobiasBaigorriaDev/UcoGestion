ALTER TABLE auth_sessions DROP CONSTRAINT auth_sessions_expiration_check;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_expiration_check CHECK (
  idle_expires_at > created_at
  AND absolute_expires_at >= idle_expires_at
);

GRANT UPDATE (idle_expires_at) ON auth_sessions TO uco_app;
GRANT UPDATE (password_hash, password_hash_version) ON users TO uco_app;
