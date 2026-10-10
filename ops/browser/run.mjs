import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = 'http://127.0.0.1:4179/apps/web/test/browser/';
const scenarios = {
  // Install API fixtures before the application can redirect or request data.
  'ui-critical': 'about:blank',
  'pwa-capability': `${fixtures}pwa-capability.html`,
  'cash-operations': `${fixtures}cash-operations.html`,
  'cash-closing': `${fixtures}cash-operations.html`,
  'offline-resilience': `${fixtures}opaque-delivery.html`,
  'offline-update': `${fixtures}offline-update.html`,
  'offline-pos': `${fixtures}offline-pos.html`,
  'offline-expiry': `${fixtures}offline-pos.html`,
  'offline-close': `${fixtures}offline-pos.html`,
  'offline-barrier': `${fixtures}offline-pos.html`,
  'offline-sealing': `${fixtures}offline-sealing.html`,
  'opaque-delivery': `${fixtures}opaque-delivery.html`,
  'offline-settings': `${fixtures}offline-settings.html`,
  'offline-restrictions': `${fixtures}offline-restrictions.html`,
  'cash-exceptional': `${fixtures}cash-operations.html`,
  'branch-deactivation': `${fixtures}branch-deactivation.html`,
  'receipt-safety': 'http://127.0.0.1:4179/test-receipt.html',
};
const critical = ['ui-critical', 'pwa-capability', 'cash-operations', 'cash-closing', 'offline-resilience', 'offline-update'];

export function readScenarioResult(stdout) {
  const response = JSON.parse(stdout);
  if (response.isError) throw new Error(response.error ?? 'Browser CLI failed.');
  const result = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
  const passed = result?.passed === true || (Array.isArray(result?.results)
    && result.results.length > 0 && result.results.every(value => value.passed === true));
  if (!passed) throw new Error('Browser scenario did not prove success.');
  return result;
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Browser fixture server exited: ${child.exitCode}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Startup. */ }
    await delay(500);
  }
  throw new Error(`Browser fixture server did not start: ${url}`);
}

async function run() {
  const mode = process.argv[2] ?? 'critical';
  const browser = process.env.BROWSER ?? 'chromium';
  if (!['critical', 'nightly', 'compatibility'].includes(mode)) throw new Error('Invalid browser suite.');
  if (!['chromium', 'firefox', 'webkit', 'chrome', 'msedge'].includes(browser)) throw new Error('Invalid browser.');
  const requestedScenario = process.env.SCENARIO;
  const suite = mode === 'critical' ? critical : Object.keys(scenarios);
  if (requestedScenario && !suite.includes(requestedScenario)) throw new Error('Scenario is outside the selected suite.');
  const selected = requestedScenario ? [requestedScenario] : suite;
  const directory = resolve(root, 'output/playwright', `${mode}-${browser}`);
  await mkdir(directory, { recursive: true });
  await mkdir(resolve(root, 'output/playwright/captures'), { recursive: true });
  const children = [];
  const logs = [];
  const start = (name, entry, args, cwd) => {
    const log = createWriteStream(resolve(directory, `${name}.log`)); logs.push(log);
    const child = spawn(process.execPath, [entry, ...args], { cwd, env: { ...process.env,
      NEXT_PUBLIC_WEB_ORIGIN: 'http://localhost:3001' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.pipe(log); child.stderr.pipe(log); children.push(child);
    return child;
  };
  const config = resolve(directory, 'browser.config.json');
  const browserConfig = {
    browserName: ['chrome', 'msedge'].includes(browser) ? 'chromium' : browser,
    launchOptions: { headless: true, ...(['chrome', 'msedge'].includes(browser) ? { channel: browser } : {}) },
  };
  const cli = async (session, ...args) => {
    let stdout;
    try {
      ({ stdout } = await execute(process.execPath, [require.resolve('@playwright/cli/playwright-cli.js'),
        `-s=${session}`, ...args, '--json'], { cwd: root, timeout: 480000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }));
    } catch (error) {
      throw new Error(error.stdout?.trim() || error.stderr?.trim() || error.message);
    }
    const response = JSON.parse(stdout);
    if (response.isError) throw new Error(response.error ?? 'Browser CLI failed.');
    return stdout;
  };
  const results = [];
  try {
    const web = start('web', require.resolve('next/dist/bin/next', { paths: [resolve(root, 'apps/web')] }),
      ['start', '--port', '3001'], resolve(root, 'apps/web'));
    const vite = resolve(dirname(require.resolve('vite/package.json',
      { paths: [dirname(require.resolve('vitest/package.json'))] })), 'bin/vite.js');
    const fixture = start('fixtures', vite,
      ['.', '--config', 'apps/web/test/browser/offline-update.vite.mjs', '--host', '127.0.0.1', '--port', '4179', '--strictPort'], root);
    await Promise.all([waitForServer('http://localhost:3001', web), waitForServer(`${fixtures}pwa-capability.html`, fixture)]);
    for (const name of selected) {
      const session = `gate-${randomUUID().slice(0, 8)}`;
      try {
        // UI fixtures route API responses. Native SW fetch handlers bypass that
        // interception; dedicated PWA/offline scenarios retain real workers.
        await writeFile(config, JSON.stringify({ browser: { ...browserConfig,
          contextOptions: { serviceWorkers: name === 'ui-critical' ? 'block' : 'allow' } } }));
        await cli(session, 'open', scenarios[name], '--config', config);
        const metadata = JSON.parse(JSON.parse(await cli(session, 'run-code',
          // The application's initial redirect can replace its execution context.
          // Inspect the same browser context through an isolated blank page.
          'async page => { const probe=await page.context().newPage();try {return {version:page.context().browser().version(),userAgent:await probe.evaluate(()=>navigator.userAgent)};}finally {await probe.close();} }')).result);
        const source = await readFile(resolve(root, `apps/web/test/browser/${name}.mjs`), 'utf8');
        const scenarioPath = resolve(directory, `${name}.mjs`);
        await writeFile(scenarioPath, source.replaceAll('.impeccable/review/', 'output/playwright/captures/'));
        const result = readScenarioResult(await cli(session, 'run-code', '--filename', scenarioPath));
        results.push({ scenario: name, browser, ...metadata, os: `${platform()} ${release()}`, passed: true, result });
        process.stdout.write(`${browser}: ${name} passed\n`);
      } catch (error) {
        results.push({ scenario: name, browser, os: `${platform()} ${release()}`, passed: false, error: error.message });
        throw error;
      } finally { await cli(session, 'close').catch(() => {}); }
    }
  } finally {
    await writeFile(resolve(directory, 'results.json'), JSON.stringify({ mode, browser,
      requestedScenario: requestedScenario ?? null, expectedScenarios: selected, results }, null, 2));
    for (const child of children) child.kill('SIGTERM');
    for (const log of logs) log.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
