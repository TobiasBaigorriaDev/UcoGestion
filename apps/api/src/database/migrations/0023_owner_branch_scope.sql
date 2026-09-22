CREATE TABLE membership_branches (
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, membership_id, branch_id),
  CONSTRAINT membership_branches_membership_tenant_fk
    FOREIGN KEY (organization_id, membership_id)
    REFERENCES memberships (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT membership_branches_branch_tenant_fk
    FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id)
    ON DELETE RESTRICT
);

ALTER TABLE membership_branches ENABLE ROW LEVEL SECURITY;

CREATE POLICY membership_branches_tenant_isolation ON membership_branches
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT ON membership_branches TO uco_app;

CREATE FUNCTION prevent_owner_branch_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.memberships
    WHERE organization_id = NEW.organization_id
      AND id = NEW.membership_id
      AND role = 'OWNER'
  ) THEN
    RAISE EXCEPTION 'OWNER_BRANCH_ASSIGNMENT_NOT_ALLOWED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION prevent_owner_branch_assignment() FROM PUBLIC;

CREATE TRIGGER membership_branches_reject_owner
BEFORE INSERT OR UPDATE ON membership_branches
FOR EACH ROW
EXECUTE FUNCTION prevent_owner_branch_assignment();

CREATE FUNCTION prevent_owner_role_with_branch_assignments()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.role = 'OWNER' AND EXISTS (
    SELECT 1
    FROM public.membership_branches
    WHERE organization_id = NEW.organization_id
      AND membership_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'OWNER_BRANCH_ASSIGNMENT_NOT_ALLOWED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION prevent_owner_role_with_branch_assignments() FROM PUBLIC;

CREATE TRIGGER memberships_reject_owner_with_assignments
BEFORE INSERT OR UPDATE OF role ON memberships
FOR EACH ROW
EXECUTE FUNCTION prevent_owner_role_with_branch_assignments();

CREATE VIEW effective_membership_branch_scope
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
    AND memberships.revoked_at IS NULL;

GRANT SELECT ON effective_membership_branch_scope TO uco_app;
