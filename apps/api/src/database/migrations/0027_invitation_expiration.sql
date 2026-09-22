DROP FUNCTION identity_api.resolve_existing_account_invitation(text, timestamptz);

CREATE FUNCTION identity_api.resolve_existing_account_invitation(
  p_token_hash text,
  p_now timestamptz
)
RETURNS TABLE (
  organization_id uuid,
  invitation_id uuid,
  user_id uuid,
  expiration_actor_user_id uuid,
  is_expired boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  resolved record;
BEGIN
  SELECT invitations.organization_id,
         invitations.id AS invitation_id,
         invitations.status,
         invitations.revoked_at,
         invitations.expires_at,
         users.id AS user_id,
         inviter.user_id AS expiration_actor_user_id
  INTO resolved
  FROM public.invitations
  LEFT JOIN public.users ON users.email_normalized = invitations.email_normalized
  JOIN public.memberships AS inviter
    ON inviter.organization_id = invitations.organization_id
   AND inviter.id = invitations.invited_by_membership_id
  WHERE invitations.token_hash = p_token_hash
  FOR UPDATE OF invitations;

  IF NOT FOUND OR resolved.status <> 'PENDING' OR resolved.revoked_at IS NOT NULL THEN
    RETURN;
  END IF;

  IF resolved.expires_at <= p_now THEN
    UPDATE public.invitations
    SET status = 'EXPIRED'
    WHERE id = resolved.invitation_id AND status = 'PENDING';

    RETURN QUERY SELECT
      resolved.organization_id,
      resolved.invitation_id,
      resolved.user_id,
      resolved.expiration_actor_user_id,
      true;
    RETURN;
  END IF;

  IF resolved.user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT
    resolved.organization_id,
    resolved.invitation_id,
    resolved.user_id,
    resolved.expiration_actor_user_id,
    false;
END;
$$;

REVOKE ALL ON FUNCTION identity_api.resolve_existing_account_invitation(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_api.resolve_existing_account_invitation(text, timestamptz) TO uco_app;

DROP FUNCTION identity_api.resolve_new_account_invitation(text, timestamptz);

CREATE FUNCTION identity_api.resolve_new_account_invitation(
  p_token_hash text,
  p_now timestamptz
)
RETURNS TABLE (
  organization_id uuid,
  invitation_id uuid,
  expiration_actor_user_id uuid,
  is_expired boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  resolved record;
BEGIN
  SELECT invitations.organization_id,
         invitations.id AS invitation_id,
         invitations.status,
         invitations.revoked_at,
         invitations.expires_at,
         inviter.user_id AS expiration_actor_user_id,
         EXISTS (
           SELECT 1
           FROM public.users
           WHERE users.email_normalized = invitations.email_normalized
         ) AS has_existing_account
  INTO resolved
  FROM public.invitations
  JOIN public.memberships AS inviter
    ON inviter.organization_id = invitations.organization_id
   AND inviter.id = invitations.invited_by_membership_id
  WHERE invitations.token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND OR resolved.status <> 'PENDING' OR resolved.revoked_at IS NOT NULL THEN
    RETURN;
  END IF;

  IF resolved.expires_at <= p_now THEN
    UPDATE public.invitations
    SET status = 'EXPIRED'
    WHERE id = resolved.invitation_id AND status = 'PENDING';

    RETURN QUERY SELECT
      resolved.organization_id,
      resolved.invitation_id,
      resolved.expiration_actor_user_id,
      true;
    RETURN;
  END IF;

  IF resolved.has_existing_account THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT
    resolved.organization_id,
    resolved.invitation_id,
    resolved.expiration_actor_user_id,
    false;
END;
$$;

REVOKE ALL ON FUNCTION identity_api.resolve_new_account_invitation(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_api.resolve_new_account_invitation(text, timestamptz) TO uco_app;
