import { readFileSync } from 'node:fs';
import { runMigrations } from '../../apps/api/dist/database/migrate.js';

const values = Object.fromEntries(readFileSync(new URL('../../output/mvp-demo/.env.local', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), JSON.parse(line.slice(split + 1))];
  }));
const url = new URL(values.DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/uconext_small_business_demo') {
  throw new Error('Only the configured local demo may be migrated');
}
url.username = 'uconext_development'; url.password = 'uconext_development';
await runMigrations(url.toString());
console.log('Migraciones versionadas aplicadas a la demo local; datos comerciales preservados.');
