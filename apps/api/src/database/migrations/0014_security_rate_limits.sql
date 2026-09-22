CREATE TABLE security_rate_limits (
  scope text NOT NULL,
  identity_hash text NOT NULL,
  ip_hash text NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, identity_hash, ip_hash),
  CONSTRAINT security_rate_limits_scope_check
    CHECK (scope IN ('LOGIN', 'PASSWORD_RESET', 'INVITATION')),
  CONSTRAINT security_rate_limits_identity_hash_check CHECK (identity_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT security_rate_limits_ip_hash_check CHECK (ip_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX security_rate_limits_updated_at_idx ON security_rate_limits (updated_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON security_rate_limits TO uco_app;
REVOKE ALL ON security_rate_limits FROM PUBLIC;
