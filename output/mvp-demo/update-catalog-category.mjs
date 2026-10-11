import { readFileSync, writeFileSync, openSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runMigrations } from '../../apps/api/dist/database/migrate.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const setup = readFileSync(new URL('setup.mjs', import.meta.url), 'utf8');
const adminUrl = setup.match(/const adminUrl = '([^']+)'/)?.[1];
const database = setup.match(/const database = '([^']+)'/)?.[1];
if (!adminUrl || database !== 'uconext_small_business_demo') throw new Error('Unexpected local database');
const migrationUrl = new URL(adminUrl); migrationUrl.pathname = `/${database}`;
await runMigrations(migrationUrl.toString());
console.log('Migraciones locales aplicadas.');
const processesFile = new URL('processes.json', import.meta.url);
const processes = JSON.parse(readFileSync(processesFile, 'utf8'));
const api = processes.find(entry => entry.name === 'api');
if (!api || !Number.isSafeInteger(api.pid)) throw new Error('Missing tracked API process');
const verified = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${api.pid}'; if ($p.CommandLine -match 'apps/api/dist/main.js') { 'VERIFIED' }`],
{ windowsHide: true, encoding: 'utf8' });
if (!verified.includes('VERIFIED')) throw new Error('API process identity mismatch');
const environment = { ...process.env, NODE_ENV: 'development' };
for (const line of readFileSync(new URL('.env.local', import.meta.url), 'utf8').split('\n')) {
  if (!line) continue; const split = line.indexOf('='); environment[line.slice(0, split)] = JSON.parse(line.slice(split + 1));
}
process.kill(api.pid);
const output = openSync(new URL('api.log', import.meta.url), 'a');
const child = spawn(process.execPath, ['apps/api/dist/main.js'], { cwd: root, env: environment,
  detached: true, windowsHide: true, stdio: ['ignore', output, output] });
child.unref(); api.pid = child.pid;
writeFileSync(processesFile, JSON.stringify(processes, null, 2));
let ready = false;
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    const response = await fetch('http://localhost:4000/api/v1/health/ready', { signal: AbortSignal.timeout(1000) });
    if (response.ok) { console.log('API local actualizada y ready.'); ready = true; break; }
  } catch { /* Wait for API startup. */ }
  await delay(500);
}
if (!ready) throw new Error('Updated API readiness failed');
