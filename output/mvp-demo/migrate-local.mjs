import { readFileSync } from 'node:fs';
import { runMigrations } from '../../apps/api/dist/database/migrate.js';

const environment = {};
for (const line of readFileSync(new URL('.env.local', import.meta.url), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const separator = line.indexOf('=');
  environment[line.slice(0, separator)] = JSON.parse(line.slice(separator + 1));
}
const migrationUrl = new URL(environment.DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(migrationUrl.hostname)
  || migrationUrl.port !== '55432' || migrationUrl.pathname !== '/uconext_small_business_demo') {
  throw new Error('Only the existing local demo may be migrated.');
}
migrationUrl.username = 'uconext_development';
migrationUrl.password = 'uconext_development';
await runMigrations(migrationUrl.toString());
console.log('Migraciones versionadas aplicadas a la demo local.');
