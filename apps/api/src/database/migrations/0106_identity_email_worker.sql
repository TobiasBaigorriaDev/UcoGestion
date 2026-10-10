ALTER TABLE identity_outbox_jobs
  ADD COLUMN lease_id uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN last_error_code text;

-- Prior versions had no lease consumer; make any unfinished legacy claim retryable.
UPDATE identity_outbox_jobs SET status='PENDING' WHERE status='PROCESSING';
ALTER TABLE identity_outbox_jobs ADD CONSTRAINT identity_email_lease_state_check CHECK (
  (status='PROCESSING' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  OR (status<>'PROCESSING' AND lease_id IS NULL AND lease_expires_at IS NULL)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='uco_identity_dispatcher') THEN
    CREATE ROLE uco_identity_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO uco_identity_dispatcher;
GRANT SELECT, UPDATE ON identity_outbox_jobs TO uco_identity_dispatcher;

CREATE FUNCTION public.claim_identity_email_jobs(p_limit integer, p_lease_seconds integer)
RETURNS TABLE(id uuid, job_key text, payload jsonb, lease_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds NOT BETWEEN 1 AND 3600
    OR p_limit IS NULL OR p_lease_seconds IS NULL THEN
    RAISE EXCEPTION 'Invalid claim bounds' USING ERRCODE='22023';
  END IF;
  RETURN QUERY WITH candidates AS (
    SELECT jobs.id FROM public.identity_outbox_jobs jobs
    WHERE (jobs.status='PENDING' AND jobs.available_at<=clock_timestamp())
      OR (jobs.status='PROCESSING' AND jobs.lease_expires_at<=clock_timestamp())
    ORDER BY jobs.available_at,jobs.id FOR UPDATE SKIP LOCKED LIMIT p_limit
  ) UPDATE public.identity_outbox_jobs jobs SET status='PROCESSING',
    lease_id=gen_random_uuid(),lease_expires_at=clock_timestamp()+(p_lease_seconds*interval '1 second'),
    attempt_count=jobs.attempt_count+1 FROM candidates WHERE jobs.id=candidates.id
    RETURNING jobs.id,jobs.job_key,jobs.payload,jobs.lease_id;
END;
$$;

CREATE FUNCTION public.finish_identity_email_job(p_id uuid,p_lease_id uuid,p_success boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result text;
BEGIN
  UPDATE public.identity_outbox_jobs SET
    status=CASE WHEN p_success THEN 'COMPLETED' WHEN attempt_count>=5 THEN 'DEAD_LETTER' ELSE 'PENDING' END,
    completed_at=CASE WHEN p_success THEN clock_timestamp() ELSE NULL END,
    payload=CASE WHEN p_success THEN '{}'::jsonb ELSE payload END,
    available_at=CASE WHEN p_success OR attempt_count>=5 THEN available_at
      ELSE clock_timestamp()+((2*power(2::numeric,least(attempt_count-1,10)))*interval '1 second') END,
    lease_id=NULL,lease_expires_at=NULL,
    last_error_code=CASE WHEN p_success THEN NULL ELSE 'HANDLER_FAILED' END
  WHERE id=p_id AND lease_id=p_lease_id AND status='PROCESSING' AND lease_expires_at>clock_timestamp()
  RETURNING status INTO result;
  RETURN result;
END;
$$;
ALTER FUNCTION public.claim_identity_email_jobs(integer,integer) OWNER TO uco_identity_dispatcher;
ALTER FUNCTION public.finish_identity_email_job(uuid,uuid,boolean) OWNER TO uco_identity_dispatcher;
REVOKE ALL ON FUNCTION public.claim_identity_email_jobs(integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_identity_email_job(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_identity_email_jobs(integer,integer) TO uco_worker;
GRANT EXECUTE ON FUNCTION public.finish_identity_email_job(uuid,uuid,boolean) TO uco_worker;
