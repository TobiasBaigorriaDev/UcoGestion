ALTER TABLE memberships
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN version bigint NOT NULL DEFAULT 1;

UPDATE memberships
SET status = 'REVOKED'
WHERE revoked_at IS NOT NULL;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_status_check CHECK (status IN ('ACTIVE', 'INACTIVE', 'REVOKED')),
  ADD CONSTRAINT memberships_version_check CHECK (version > 0),
  ADD CONSTRAINT memberships_revocation_state_check CHECK (
    (status = 'REVOKED' AND revoked_at IS NOT NULL)
    OR (status <> 'REVOKED' AND revoked_at IS NULL)
  ),
  ADD CONSTRAINT memberships_deactivation_state_check CHECK (
    (status = 'INACTIVE' AND deactivated_at IS NOT NULL)
    OR (status <> 'INACTIVE' AND deactivated_at IS NULL)
  );

CREATE OR REPLACE VIEW effective_membership_branch_scope
WITH (security_invoker = true, security_barrier = true)
AS
  SELECT
    memberships.organization_id,
    memberships.id AS membership_id,
    branches.id AS branch_id
  FROM memberships
  JOIN branches
    ON branches.organization_id = memberships.organization_id
  WHERE memberships.role = 'OWNER'
    AND memberships.status = 'ACTIVE'
    AND memberships.revoked_at IS NULL

  UNION ALL

  SELECT
    membership_branches.organization_id,
    membership_branches.membership_id,
    membership_branches.branch_id
  FROM membership_branches
  JOIN memberships
    ON memberships.organization_id = membership_branches.organization_id
   AND memberships.id = membership_branches.membership_id
  WHERE memberships.role <> 'OWNER'
    AND memberships.status = 'ACTIVE'
    AND memberships.revoked_at IS NULL;

CREATE OR REPLACE FUNCTION identity_api.list_active_memberships()
RETURNS TABLE (organization_id uuid, organization_name text, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT organizations.id, organizations.name, memberships.role
  FROM memberships
  JOIN organizations ON organizations.id = memberships.organization_id
  WHERE memberships.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND memberships.status = 'ACTIVE'
    AND memberships.revoked_at IS NULL
    AND organizations.status = 'ACTIVE'
  ORDER BY organizations.name, organizations.id;
$$;

CREATE OR REPLACE FUNCTION identity_api.select_active_membership(p_organization_id uuid)
RETURNS TABLE (organization_id uuid, organization_name text, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT organizations.id, organizations.name, memberships.role
  FROM memberships
  JOIN organizations ON organizations.id = memberships.organization_id
  WHERE memberships.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND memberships.organization_id = p_organization_id
    AND memberships.status = 'ACTIVE'
    AND memberships.revoked_at IS NULL
    AND organizations.status = 'ACTIVE';
$$;

CREATE OR REPLACE FUNCTION platform_api.recover_owner(
  p_actor_user_id uuid,
  p_request_id text,
  p_request_hash text,
  p_organization_id uuid,
  p_owner_email text
)
RETURNS TABLE (membership_id uuid, user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing_hash text;
  v_existing_result jsonb;
  v_organization_status text;
  v_user_id uuid;
  v_membership_id uuid;
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
      (v_existing_result->>'membershipId')::uuid,
      (v_existing_result->>'userId')::uuid;
    RETURN;
  END IF;

  SELECT organizations.status INTO v_organization_status
  FROM organizations WHERE organizations.id = p_organization_id FOR UPDATE;
  IF v_organization_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'OWNER_RECOVERY_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM memberships
    WHERE memberships.organization_id = p_organization_id
      AND memberships.role = 'OWNER'
      AND memberships.status = 'ACTIVE'
      AND memberships.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'OWNER_RECOVERY_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;

  SELECT users.id INTO v_user_id
  FROM users
  WHERE users.email_normalized = p_owner_email AND users.disabled_at IS NULL
  FOR UPDATE;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'OWNER_RECOVERY_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;

  SELECT memberships.id INTO v_membership_id
  FROM memberships
  WHERE memberships.organization_id = p_organization_id
    AND memberships.user_id = v_user_id
    AND memberships.status <> 'REVOKED'
    AND memberships.revoked_at IS NULL
  FOR UPDATE;

  IF v_membership_id IS NULL THEN
    v_membership_id := gen_random_uuid();
    INSERT INTO memberships (id, organization_id, user_id, role)
    VALUES (v_membership_id, p_organization_id, v_user_id, 'OWNER');
  ELSE
    UPDATE memberships
    SET role = 'OWNER', status = 'ACTIVE', deactivated_at = NULL, version = version + 1
    WHERE memberships.id = v_membership_id;
  END IF;

  INSERT INTO security_audit_events (
    id, actor_user_id, request_id, entity_type, entity_id, action, context_data
  ) VALUES (
    gen_random_uuid(), p_actor_user_id, p_request_id, 'organization', p_organization_id,
    'OWNER_RECOVERED', jsonb_build_object('membershipId', v_membership_id, 'recoveredUserId', v_user_id)
  );

  INSERT INTO platform_operations (request_id, request_hash, operation_type, result)
  VALUES (
    p_request_id,
    p_request_hash,
    'OWNER_RECOVERY',
    jsonb_build_object('membershipId', v_membership_id, 'userId', v_user_id)
  );

  RETURN QUERY SELECT v_membership_id, v_user_id;
END;
$$;

CREATE POLICY memberships_tenant_update ON memberships
  FOR UPDATE TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT UPDATE (role, status, revoked_at, deactivated_at, version) ON memberships TO uco_app;
GRANT DELETE ON membership_branches TO uco_app;
