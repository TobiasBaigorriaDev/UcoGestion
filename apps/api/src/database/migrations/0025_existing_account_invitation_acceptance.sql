CREATE FUNCTION identity_api.resolve_existing_account_invitation(
  p_token_hash text,
  p_now timestamptz
)
RETURNS TABLE (organization_id uuid, invitation_id uuid, user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT invitations.organization_id, invitations.id, users.id
  FROM invitations
  JOIN users ON users.email_normalized = invitations.email_normalized
  WHERE invitations.token_hash = p_token_hash
    AND invitations.status = 'PENDING'
    AND invitations.revoked_at IS NULL
    AND invitations.expires_at > p_now;
$$;

REVOKE ALL ON FUNCTION identity_api.resolve_existing_account_invitation(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_api.resolve_existing_account_invitation(text, timestamptz) TO uco_app;

GRANT INSERT ON memberships, membership_branches TO uco_app;
GRANT UPDATE ON invitations TO uco_app;

CREATE POLICY memberships_tenant_insert ON memberships
  FOR INSERT TO uco_app
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
