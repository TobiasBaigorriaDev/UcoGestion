CREATE ROLE uco_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE uco_outbox_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

CREATE TABLE outbox_jobs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  job_key text NOT NULL CHECK (length(job_key) > 0),
  job_type text NOT NULL CHECK (length(job_type) > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  actor_user_id uuid NOT NULL,
  branch_id uuid,
  authorization_class text NOT NULL CHECK (length(authorization_class) > 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'DEAD_LETTER')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT outbox_jobs_organization_job_key_key UNIQUE (organization_id, job_key),
  CONSTRAINT outbox_jobs_branch_organization_fkey
    FOREIGN KEY (organization_id, branch_id) REFERENCES branches(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX outbox_jobs_claimable_idx ON outbox_jobs (available_at, id)
  WHERE status IN ('PENDING', 'PROCESSING');

GRANT USAGE ON SCHEMA public TO uco_worker, uco_outbox_dispatcher;
GRANT SELECT, INSERT, UPDATE ON TABLE outbox_jobs TO uco_app;
GRANT SELECT, UPDATE ON TABLE outbox_jobs TO uco_outbox_dispatcher;
REVOKE ALL ON TABLE outbox_jobs FROM PUBLIC;

ALTER TABLE outbox_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY outbox_jobs_tenant_isolation ON outbox_jobs
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY outbox_jobs_dispatcher_select ON outbox_jobs
  FOR SELECT TO uco_outbox_dispatcher
  USING (true);

CREATE POLICY outbox_jobs_dispatcher_update ON outbox_jobs
  FOR UPDATE TO uco_outbox_dispatcher
  USING (true)
  WITH CHECK (true);

CREATE FUNCTION public.claim_outbox_jobs(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (job_id uuid, organization_id uuid, job_type text, lease_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'p_lease_seconds must be between 1 and 3600' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT jobs.id
    FROM public.outbox_jobs AS jobs
    WHERE (jobs.status = 'PENDING' AND jobs.available_at <= pg_catalog.clock_timestamp())
      OR (jobs.status = 'PROCESSING' AND jobs.lease_expires_at <= pg_catalog.clock_timestamp())
    ORDER BY jobs.available_at, jobs.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.outbox_jobs AS jobs
    SET status = 'PROCESSING',
      lease_id = pg_catalog.gen_random_uuid(),
      lease_expires_at = pg_catalog.clock_timestamp() + (p_lease_seconds * interval '1 second'),
      attempt_count = jobs.attempt_count + 1
    FROM candidates
    WHERE jobs.id = candidates.id
    RETURNING jobs.id, jobs.organization_id, jobs.job_type, jobs.lease_id
  )
  SELECT claimed.id, claimed.organization_id, claimed.job_type, claimed.lease_id
  FROM claimed;
END;
$$;

ALTER FUNCTION public.claim_outbox_jobs(integer, integer) OWNER TO uco_outbox_dispatcher;
REVOKE ALL ON FUNCTION public.claim_outbox_jobs(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_outbox_jobs(integer, integer) TO uco_worker;
