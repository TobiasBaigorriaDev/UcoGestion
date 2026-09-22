ALTER TABLE platform_operations DROP CONSTRAINT platform_operations_operation_type_check;
ALTER TABLE platform_operations ADD CONSTRAINT platform_operations_operation_type_check
  CHECK (operation_type IN ('PROVISION_ORGANIZATION', 'OWNER_RECOVERY'));

CREATE FUNCTION platform_api.recover_owner(
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
    AND memberships.revoked_at IS NULL
  FOR UPDATE;

  IF v_membership_id IS NULL THEN
    v_membership_id := gen_random_uuid();
    INSERT INTO memberships (id, organization_id, user_id, role)
    VALUES (v_membership_id, p_organization_id, v_user_id, 'OWNER');
  ELSE
    UPDATE memberships SET role = 'OWNER' WHERE memberships.id = v_membership_id;
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

REVOKE ALL ON FUNCTION platform_api.recover_owner(uuid, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_api.recover_owner(uuid, text, text, uuid, text) TO uco_platform;
