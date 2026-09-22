CREATE FUNCTION identity_api.resolve_new_account_invitation(
  p_token_hash text,
  p_now timestamptz
)
RETURNS TABLE (organization_id uuid, invitation_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT invitations.organization_id, invitations.id
  FROM invitations
  WHERE invitations.token_hash = p_token_hash
    AND invitations.status = 'PENDING'
    AND invitations.revoked_at IS NULL
    AND invitations.expires_at > p_now
    AND NOT EXISTS (
      SELECT 1
      FROM users
      WHERE users.email_normalized = invitations.email_normalized
    );
$$;

REVOKE ALL ON FUNCTION identity_api.resolve_new_account_invitation(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_api.resolve_new_account_invitation(text, timestamptz) TO uco_app;
