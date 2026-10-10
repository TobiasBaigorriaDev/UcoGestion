import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const browser = process.argv[2] ?? 'chromium';
if (!['chromium', 'firefox', 'webkit', 'chrome', 'msedge'].includes(browser)) throw new Error('Invalid browser.');
const cliDirectory = dirname(require.resolve('@playwright/cli/package.json'));
const playwrightDirectory = dirname(require.resolve('playwright/package.json', { paths: [cliDirectory] }));
execFileSync(process.execPath, [resolve(playwrightDirectory, 'cli.js'), 'install',
  ...(process.platform === 'linux' ? ['--with-deps'] : []), browser], { stdio: 'inherit', windowsHide: true });
