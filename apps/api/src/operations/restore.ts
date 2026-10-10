import type { PoolClient } from 'pg';
import { validateKeyReferences } from '../modules/offline-sync/index.js';
export { validateKeyReferences } from '../modules/offline-sync/index.js';

export function validateRestoreTarget(target: string, primary: string): void {
  const destination = new URL(target), source = new URL(primary);
  if (destination.hostname === source.hostname && (destination.port || '5432') === (source.port || '5432')) throw new Error('Restore cannot target the primary cluster.');
  if (!/^\/uco_restore_[a-z0-9_]+$/.test(destination.pathname)) throw new Error('Restore must target a new isolated database.');
}

/** Recovery-only administrator connection to a disposable cluster, never a tenant runtime pool. */
export async function checkRecoveredDatabase(client: PoolClient, environment: NodeJS.ProcessEnv): Promise<void> {
  await client.query('BEGIN READ ONLY');
  try {
    const ingestion = await client.query<{key_id:string;public_key_pem:string}>('SELECT key_id,public_key_pem FROM offline_ingestion_key_registry');
    const ack = await client.query<{key_id:string;public_key_pem:string}>('SELECT DISTINCT signing_key_id AS key_id,public_key_pem FROM configuration_versions');
    await validateKeyReferences(environment,ingestion.rows,ack.rows);
    const inventory = await client.query(`SELECT 1 FROM branch_stocks s FULL JOIN
      (SELECT organization_id,branch_id,item_id,sum(delta) AS balance FROM inventory_movements GROUP BY organization_id,branch_id,item_id) m
      USING (organization_id,branch_id,item_id) WHERE s.quantity IS DISTINCT FROM coalesce(m.balance,0) LIMIT 1`);
    const cash = await client.query(`SELECT 1 FROM cash_sessions s LEFT JOIN
      (SELECT organization_id,cash_session_id,sum(delta) AS balance FROM cash_movements GROUP BY organization_id,cash_session_id) m
      ON m.organization_id=s.organization_id AND m.cash_session_id=s.id
      WHERE s.expected_cash <> s.opening_cash+coalesce(m.balance,0) LIMIT 1`);
    if (inventory.rowCount || cash.rowCount) throw new Error('Recovered ledger projection divergence.');
    const constraints = await client.query("SELECT 1 FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated LIMIT 1");
    if (constraints.rowCount) throw new Error('Unvalidated recovered constraint.');
    const insecure = await client.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id'
      WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity LIMIT 1`);
    if (insecure.rowCount) throw new Error('Recovered tenant table without RLS.');
    const roles = await client.query("SELECT 1 FROM pg_roles WHERE rolname='uco_app' AND (rolsuper OR rolbypassrls)");
    if (roles.rowCount) throw new Error('Recovered runtime role bypasses RLS.');
    const worker = await client.query("SELECT to_regprocedure('claim_report_artifact_jobs(integer,integer)') AS dispatcher");
    if (!worker.rows[0]?.dispatcher) throw new Error('Recovered worker dispatcher unavailable.');
    // Default deny must survive pg_restore together with table privileges.
    await client.query('SET LOCAL ROLE uco_app');
    await client.query("SELECT set_config('app.organization_id','',true)");
    if ((await client.query('SELECT id FROM organizations')).rowCount) throw new Error('Recovered RLS default deny failed.');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function prepareEmptyRestore(client: PoolClient): Promise<void> {
  const tables = await client.query("SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') LIMIT 1");
  if (tables.rowCount) throw new Error('Restore requires an empty isolated database.');
  for (const role of ['uco_app','uco_platform','uco_worker','uco_outbox_dispatcher','uco_identity_dispatcher']) {
    if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount) {
      await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    }
  }
}

/** pg_restore --no-owner must not leave identity dispatch running as the recovery administrator. */
export async function restoreIdentityDispatcherOwnership(client: PoolClient): Promise<void> {
  await client.query('ALTER FUNCTION public.claim_identity_email_jobs(integer,integer) OWNER TO uco_identity_dispatcher');
  await client.query('ALTER FUNCTION public.finish_identity_email_job(uuid,uuid,boolean) OWNER TO uco_identity_dispatcher');
}
