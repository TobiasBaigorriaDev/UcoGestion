import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export function postgresEnvironment(connectionString: string): NodeJS.ProcessEnv {
  const url = new URL(connectionString);
  if (!['postgres:','postgresql:'].includes(url.protocol)) throw new Error('Invalid PostgreSQL URL.');
  return {...process.env,PGHOST:url.hostname,PGPORT:url.port || '5432',PGDATABASE:decodeURIComponent(url.pathname.slice(1)),
    PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGCONNECT_TIMEOUT:'10',
    PGSSLMODE:url.searchParams.get('sslmode') ?? 'prefer'};
}
export async function postgresTool(tool: 'pg_dump'|'pg_restore', args: string[], connectionString: string): Promise<void> {
  try { await execute(tool,args,{env:postgresEnvironment(connectionString),timeout:6*60*60*1000,maxBuffer:1024*1024}); }
  catch { throw new Error(`${tool} failed; inspect protected PostgreSQL diagnostics.`); }
}
