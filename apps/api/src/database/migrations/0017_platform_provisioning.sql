ALTER TABLE organizations
  ADD COLUMN name text NOT NULL DEFAULT 'Organización',
  ADD COLUMN country_code text NOT NULL DEFAULT 'AR',
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT organizations_country_code_check CHECK (country_code = 'AR'),
  ADD CONSTRAINT organizations_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  ADD CONSTRAINT organizations_version_check CHECK (version > 0);

ALTER TABLE branches
  ADD COLUMN name_norm text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT branches_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  ADD CONSTRAINT branches_version_check CHECK (version > 0);

CREATE UNIQUE INDEX branches_organization_name_norm_key ON branches (organization_id, name_norm);

CREATE TABLE platform_admins (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_operations (
  request_id text PRIMARY KEY CHECK (length(request_id) > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  operation_type text NOT NULL CHECK (operation_type IN ('PROVISION_ORGANIZATION')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE security_audit_events (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) > 0),
  entity_type text NOT NULL CHECK (length(entity_type) > 0),
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (length(action) > 0),
  context_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context_data) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION prevent_security_audit_events_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'security_audit_events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER security_audit_events_immutable
BEFORE UPDATE OR DELETE ON security_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_security_audit_events_mutation();

REVOKE ALL ON platform_admins, platform_operations, security_audit_events FROM PUBLIC, uco_app, uco_platform;

CREATE FUNCTION platform_api.provision_organization(
  p_actor_user_id uuid,
  p_request_id text,
  p_request_hash text,
  p_organization_name text,
  p_timezone text,
  p_owner_email text,
  p_owner_password_hash text,
  p_owner_password_hash_version integer,
  p_first_branch_name text
)
RETURNS TABLE (organization_id uuid, branch_id uuid, user_id uuid, membership_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing_hash text;
  v_existing_result jsonb;
  v_organization_id uuid := gen_random_uuid();
  v_branch_id uuid := gen_random_uuid();
  v_user_id uuid := gen_random_uuid();
  v_membership_id uuid := gen_random_uuid();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform_admins
    WHERE platform_admins.user_id = p_actor_user_id AND platform_admins.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = '42501';
  END IF;

  SELECT operations.request_hash, operations.result
    INTO v_existing_hash, v_existing_result
  FROM platform_operations AS operations
  WHERE operations.request_id = p_request_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_hash <> p_request_hash THEN
      RAISE EXCEPTION 'platform request id reused with another payload' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT
      (v_existing_result->>'organizationId')::uuid,
      (v_existing_result->>'branchId')::uuid,
      (v_existing_result->>'userId')::uuid,
      (v_existing_result->>'membershipId')::uuid;
    RETURN;
  END IF;

  INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
  VALUES (v_user_id, p_owner_email, p_owner_password_hash, p_owner_password_hash_version);

  INSERT INTO organizations (id, name, country_code, base_currency, timezone, status)
  VALUES (v_organization_id, p_organization_name, 'AR', 'ARS', p_timezone, 'ACTIVE');

  INSERT INTO branches (id, organization_id, name, status)
  VALUES (v_branch_id, v_organization_id, p_first_branch_name, 'ACTIVE');

  INSERT INTO memberships (id, organization_id, user_id, role)
  VALUES (v_membership_id, v_organization_id, v_user_id, 'OWNER');

  INSERT INTO security_audit_events (
    id, actor_user_id, request_id, entity_type, entity_id, action, context_data
  ) VALUES (
    gen_random_uuid(), p_actor_user_id, p_request_id, 'organization', v_organization_id,
    'ORGANIZATION_PROVISIONED',
    jsonb_build_object('branchId', v_branch_id, 'ownerUserId', v_user_id)
  );

  INSERT INTO platform_operations (request_id, request_hash, operation_type, result)
  VALUES (
    p_request_id,
    p_request_hash,
    'PROVISION_ORGANIZATION',
    jsonb_build_object(
      'organizationId', v_organization_id,
      'branchId', v_branch_id,
      'userId', v_user_id,
      'membershipId', v_membership_id
    )
  );

  RETURN QUERY SELECT v_organization_id, v_branch_id, v_user_id, v_membership_id;
END;
$$;

REVOKE ALL ON FUNCTION platform_api.provision_organization(uuid, text, text, text, text, text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_api.provision_organization(uuid, text, text, text, text, text, text, integer, text) TO uco_platform;
