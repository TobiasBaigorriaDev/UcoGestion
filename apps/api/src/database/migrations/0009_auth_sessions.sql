CREATE TABLE "auth_sessions" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "token_hash" text NOT NULL,
  "idle_expires_at" timestamptz NOT NULL,
  "absolute_expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "auth_sessions_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "auth_sessions_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "auth_sessions_expiration_check" CHECK (
    "idle_expires_at" > "created_at"
    AND "absolute_expires_at" > "idle_expires_at"
  )
);

GRANT SELECT ("id", "user_id", "token_hash", "idle_expires_at", "absolute_expires_at", "revoked_at", "created_at") ON "auth_sessions" TO uco_app;
GRANT INSERT ("id", "user_id", "token_hash", "idle_expires_at", "absolute_expires_at") ON "auth_sessions" TO uco_app;
