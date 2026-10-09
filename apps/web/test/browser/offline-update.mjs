/* global window, navigator */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.waitForFunction(() => Boolean(window.migration));
  const original = await page.evaluate(() => window.migration.seed(1));
  const blocked = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/sw.js');
    const worker = registration.installing;
    if (!worker) throw new Error('No installing worker');
    return new Promise(resolve => worker.addEventListener('statechange', () => {
      if (worker.state === 'redundant') resolve(true);
      if (worker.state === 'activated') resolve(false);
    }));
  });
  check(blocked, 'Unmigrated database allowed worker activation');
  await page.evaluate(() => window.migration.migrate());
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.migration));
  const migrated = await page.evaluate(() => window.migration.snapshot());
  check(migrated.version === 4, 'Forward migration missing');
  check(JSON.stringify(migrated.records) === JSON.stringify(original.records), 'Encrypted records changed');
  check(JSON.stringify(migrated.pending) === JSON.stringify(original.pending), 'Pending bytes changed');
  const incompatible = await page.evaluate(() => window.migration.seed(99));
  check(await page.evaluate(async () => {
    try { await window.migration.migrate(); return false; } catch { return true; }
  }), 'Unknown format accepted');
  check(JSON.stringify(await page.evaluate(() => window.migration.snapshot())) === JSON.stringify(incompatible), 'Rejected migration mutated data');
  return { passed: true, scenarios: ['worker-blocked-before-migration', 'worker-activation-after-migration',
    'reload', 'exact-record-and-envelope-bytes', 'unknown-format-rollback'] };
}
