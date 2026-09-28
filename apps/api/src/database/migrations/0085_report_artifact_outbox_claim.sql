CREATE FUNCTION public.claim_report_artifact_jobs(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (job_id uuid, organization_id uuid, job_type text, lease_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 100 OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid report claim bounds' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT jobs.id FROM public.outbox_jobs AS jobs
    WHERE jobs.job_type IN ('REPORT_PDF', 'OBJECT_FILE_CLEANUP') AND
      ((jobs.status = 'PENDING' AND jobs.available_at <= pg_catalog.clock_timestamp()) OR
       (jobs.status = 'PROCESSING' AND jobs.lease_expires_at <= pg_catalog.clock_timestamp()))
    ORDER BY jobs.available_at, jobs.id FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE public.outbox_jobs AS jobs
    SET status = 'PROCESSING', lease_id = pg_catalog.gen_random_uuid(),
      lease_expires_at = pg_catalog.clock_timestamp() + (p_lease_seconds * interval '1 second'),
      attempt_count = jobs.attempt_count + 1
    FROM candidates WHERE jobs.id = candidates.id
    RETURNING jobs.id, jobs.organization_id, jobs.job_type, jobs.lease_id
  )
  SELECT claimed.id, claimed.organization_id, claimed.job_type, claimed.lease_id FROM claimed;
END;
$$;
ALTER FUNCTION public.claim_report_artifact_jobs(integer, integer) OWNER TO uco_outbox_dispatcher;
REVOKE ALL ON FUNCTION public.claim_report_artifact_jobs(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_report_artifact_jobs(integer, integer) TO uco_worker;
