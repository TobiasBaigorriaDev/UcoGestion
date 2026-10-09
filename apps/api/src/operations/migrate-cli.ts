import { runMigrations } from '../database/migrate.js';
import { createJsonLogger } from '../core/observability/logger.js';
import { required } from './backup-store.js';

void runMigrations(required('MIGRATION_DATABASE_URL')).then(() => {
  createJsonLogger({component:'migration'}).info({status:'COMPLETED'},'Versioned migration job completed');
}).catch(() => {
  createJsonLogger({component:'migration'}).error({error_code:'MIGRATION_FAILED'},'Rollout blocked by migration failure');
  process.exitCode=1;
});
