import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { downloadBackup } from './backup.js';
import { IndependentBackupStore, required } from './backup-store.js';
import { checkRecoveredDatabase, prepareEmptyRestore, validateRestoreTarget } from './restore.js';
import { postgresTool } from './postgres-tools.js';
import { runMigrations } from '../database/migrate.js';
import { createJsonLogger } from '../core/observability/logger.js';
import { runRecoverySmoke } from './recovery-smoke.js';
import { verifyRecoveryTargets } from './recovery-targets.js';

async function main(): Promise<void> {
  const started = Date.now(), target = required('RESTORE_DATABASE_URL');
  validateRestoreTarget(target,required('PRIMARY_DATABASE_IDENTITY_URL'));
  const directory = await mkdtemp(join(tmpdir(),'uco-restore-'));
  const key = Buffer.from((await readFile(required('BACKUP_KEY_FILE'),'utf8')).trim(),'base64');
  const pool = new Pool({connectionString:target});
  const client = await pool.connect();
  try {
    const store=new IndependentBackupStore();
    const recovered = await downloadBackup(directory,process.env.RESTORE_BACKUP_ID || await store.latestId(),key,store);
    if (recovered.manifest.keyReference !== required('BACKUP_KEY_REFERENCE')) throw new Error('Select the key version referenced by this backup.');
    await prepareEmptyRestore(client);
    await postgresTool('pg_restore',['--exit-on-error','--single-transaction','--no-owner',
      `--dbname=${decodeURIComponent(new URL(target).pathname.slice(1))}`,join(directory,'database.dump')],target);
    await runMigrations(target);
    await checkRecoveredDatabase(client,recovered.environment);
    await runRecoverySmoke(target,recovered.environment);
    const targets=verifyRecoveryTargets(recovered.manifest.createdAt,
      process.env.RECOVERY_INCIDENT_AT ? Date.parse(process.env.RECOVERY_INCIDENT_AT) : started,started,Date.now());
    // The protected drill workspace is consumed by the application smoke harness.
    await writeFile(required('RESTORE_CUSTODY_OUTPUT'),JSON.stringify(recovered.environment),{mode:0o600,flag:'wx'});
    const evidence = {backupId:recovered.manifest.id,backupCreatedAt:recovered.manifest.createdAt,
      checksum:recovered.manifest.databaseSha256,durationSeconds:(Date.now()-started)/1000,
      migrations:'passed',keys:'passed',ledgers:'passed',rls:'passed',api:'passed',worker:'passed',files:'passed',...targets};
    await writeFile(required('RESTORE_EVIDENCE_OUTPUT'),JSON.stringify(evidence,null,2),{mode:0o600});
    createJsonLogger({component:'restore'}).info(evidence,'Isolated database and application restore validated');
  } finally { key.fill(0); client.release(); await pool.end(); await rm(directory,{recursive:true,force:true}); }
}
void main().catch(() => { createJsonLogger({component:'restore'}).error({error_code:'RESTORE_FAILED'},'Isolated restore failed'); process.exitCode=1; });
