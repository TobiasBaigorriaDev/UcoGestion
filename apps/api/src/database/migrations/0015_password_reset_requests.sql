CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_tokens_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT password_reset_tokens_expiration_check CHECK (expires_at > created_at)
);

CREATE TABLE identity_outbox_jobs (
  id uuid PRIMARY KEY,
  job_key text NOT NULL UNIQUE CHECK (length(job_key) > 0),
  job_type text NOT NULL CHECK (job_type IN ('PASSWORD_RESET_EMAIL')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'DEAD_LETTER')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX identity_outbox_jobs_claimable_idx ON identity_outbox_jobs (available_at, id)
  WHERE status IN ('PENDING', 'PROCESSING');

GRANT SELECT, INSERT, UPDATE ON password_reset_tokens, identity_outbox_jobs TO uco_app;
REVOKE ALL ON password_reset_tokens, identity_outbox_jobs FROM PUBLIC;
