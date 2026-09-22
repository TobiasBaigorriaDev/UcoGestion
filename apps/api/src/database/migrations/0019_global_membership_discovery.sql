CREATE SCHEMA identity_api;
REVOKE ALL ON SCHEMA identity_api FROM PUBLIC;
GRANT USAGE ON SCHEMA identity_api TO uco_app;

CREATE FUNCTION identity_api.list_active_memberships()
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
    AND memberships.revoked_at IS NULL
    AND organizations.status = 'ACTIVE'
  ORDER BY organizations.name, organizations.id;
$$;

CREATE FUNCTION identity_api.select_active_membership(p_organization_id uuid)
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
    AND memberships.revoked_at IS NULL
    AND organizations.status = 'ACTIVE';
$$;

REVOKE ALL ON FUNCTION identity_api.list_active_memberships() FROM PUBLIC;
REVOKE ALL ON FUNCTION identity_api.select_active_membership(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_api.list_active_memberships() TO uco_app;
GRANT EXECUTE ON FUNCTION identity_api.select_active_membership(uuid) TO uco_app;
