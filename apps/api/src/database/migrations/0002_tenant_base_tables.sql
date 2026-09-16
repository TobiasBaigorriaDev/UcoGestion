CREATE TABLE "organizations" (
  "id" uuid PRIMARY KEY,
  "base_currency" text NOT NULL,
  "timezone" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "branches" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL REFERENCES "organizations" ("id") ON DELETE RESTRICT,
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "branches_organization_id_id_key" UNIQUE ("organization_id", "id")
);

CREATE TABLE "cash_registers" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "branch_id" uuid NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cash_registers_branch_tenant_fk"
    FOREIGN KEY ("organization_id", "branch_id")
    REFERENCES "branches" ("organization_id", "id")
    ON DELETE RESTRICT
);
