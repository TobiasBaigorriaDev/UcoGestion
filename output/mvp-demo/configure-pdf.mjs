import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const file = new URL('.env.local', import.meta.url);
const original = readFileSync(file, 'utf8');
const environment = Object.fromEntries(original.split('\n').filter(Boolean).map(line => {
  const split = line.indexOf('='); return [line.slice(0, split), JSON.parse(line.slice(split + 1))];
}));
if (!environment.WORKER_DISPATCH_DATABASE_URL) {
  const adminUrl = new URL(environment.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(adminUrl.hostname)) throw new Error('Only the local demo may be configured');
  adminUrl.username = 'uconext_development'; adminUrl.password = 'uconext_development';
  const admin = new Pool({ connectionString: adminUrl.toString() });
  try {
    const password = randomBytes(24).toString('hex');
    const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='uco_demo_report_dispatch'");
    if (exists.rowCount) throw new Error('Dispatcher role already exists without saved configuration');
    await admin.query(`CREATE ROLE uco_demo_report_dispatch LOGIN PASSWORD '${password}' IN ROLE uco_worker`);
    const dispatcherUrl = new URL(environment.DATABASE_URL);
    dispatcherUrl.username = 'uco_demo_report_dispatch'; dispatcherUrl.password = password;
    const actor = await admin.query("SELECT id FROM users WHERE email_normalized='setup@uco-demo.test'");
    if (!actor.rows[0]) throw new Error('Local setup actor missing');
    environment.WORKER_DISPATCH_DATABASE_URL = dispatcherUrl.toString();
    environment.WORKER_USER_ID = actor.rows[0].id;
    writeFileSync(file, Object.entries(environment).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n');
  } finally { await admin.end(); }
}
console.log('Local PDF worker configured; existing keys and commercial data preserved');
