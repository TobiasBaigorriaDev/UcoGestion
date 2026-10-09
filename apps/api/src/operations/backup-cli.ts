import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadOfflineKeys, validateKeyReferences } from '../modules/offline-sync/index.js';
import { publishBackup } from './backup.js';
import { IndependentBackupStore, required } from './backup-store.js';
import { postgresTool } from './postgres-tools.js';
import { createJsonLogger } from '../core/observability/logger.js';

export const custodyNames = ['OFFLINE_SIGNING_PRIVATE_KEY','OFFLINE_SIGNING_KEY_ID','OFFLINE_INGESTION_KEYS',
  'OFFLINE_ACK_SIGNING_KEYS','DEVICE_CERTIFICATE_KEY'] as const;

async function main(): Promise<void> {
  const store = new IndependentBackupStore();
  const connection = required('BACKUP_DATABASE_URL');
  const directory = await mkdtemp(join(tmpdir(),'uco-backup-'));
  const key = Buffer.from((await readFile(required('BACKUP_KEY_FILE'),'utf8')).trim(),'base64');
  if (key.length !== 32) throw new Error('Backup key must contain 32 bytes encoded as base64.');
  const environment = Object.fromEntries(custodyNames.map(name => [name, name==='OFFLINE_ACK_SIGNING_KEYS' ? process.env[name] ?? '{}' : required(name)]));
  loadOfflineKeys(environment);
  const pool = new Pool({connectionString:connection});
  const client = await pool.connect();
  try {
    await store.configureRetention();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const createdAt = new Date().toISOString();
    const snapshot = (await client.query<{id:string}>('SELECT pg_export_snapshot() AS id')).rows[0]?.id;
    if (!snapshot) throw new Error('Snapshot unavailable.');
    await validateKeyReferences(environment,
      (await client.query<{key_id:string;public_key_pem:string}>('SELECT key_id,public_key_pem FROM offline_ingestion_key_registry')).rows,
      (await client.query<{key_id:string;public_key_pem:string}>('SELECT DISTINCT signing_key_id AS key_id,public_key_pem FROM configuration_versions')).rows);
    const dump = join(directory,'database.dump');
    await postgresTool('pg_dump',['--format=custom','--no-owner',`--snapshot=${snapshot}`,`--file=${dump}`],connection);
    await client.query('COMMIT');
    const manifest = await publishBackup(directory,dump,environment,key,required('BACKUP_KEY_REFERENCE'),createdAt,store);
    createJsonLogger({component:'backup'}).info({backup_id:manifest.id,created_at:createdAt,retention_days:35,
      checksum:manifest.databaseSha256,key_reference:manifest.keyReference},'Encrypted daily backup committed');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { key.fill(0); client.release(); await pool.end(); await rm(directory,{recursive:true,force:true}); }
}

void main().catch(() => { createJsonLogger({component:'backup'}).error({error_code:'BACKUP_FAILED'},'Daily backup failed'); process.exitCode=1; });
