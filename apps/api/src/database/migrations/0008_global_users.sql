CREATE TABLE "users" (
  "id" uuid PRIMARY KEY,
  "email_normalized" text NOT NULL,
  "password_hash" text NOT NULL,
  "password_hash_version" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "users_email_normalized_key" UNIQUE ("email_normalized"),
  CONSTRAINT "users_email_normalized_check" CHECK (
    "email_normalized" <> ''
    AND "email_normalized" = lower(btrim("email_normalized"))
  ),
  CONSTRAINT "users_password_hash_check" CHECK (
    "password_hash" LIKE '$argon2id$v=19$%'
  ),
  CONSTRAINT "users_password_hash_version_check" CHECK ("password_hash_version" > 0)
);

GRANT SELECT ("id", "email_normalized", "password_hash", "password_hash_version", "created_at") ON "users" TO uco_app;
GRANT INSERT ("id", "email_normalized", "password_hash", "password_hash_version") ON "users" TO uco_app;
