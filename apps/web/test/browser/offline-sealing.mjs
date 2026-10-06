/* global window */
// playwright-cli run-code expects a standalone function expression.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const url = 'http://127.0.0.1:4179/apps/web/test/browser/offline-sealing.html';
  for (const other of page.context().pages()) if (other !== page) await other.close();
  await page.waitForFunction(() => Boolean(window.harness));
  await page.evaluate(() => window.harness.initialize());
  await page.context().setOffline(true);
  const first = await page.evaluate(() => window.harness.seal());
  check(first.sequence === '1', 'Offline sequence must start at one');
  await page.evaluate(() => window.harness.rollback());
  const pending = await page.evaluate(() => window.harness.pending());
  await page.evaluate(() => window.harness.lock());
  const rejected = await page.evaluate(async () => {
    try { await window.harness.seal(); return false; } catch { return true; }
  });
  check(rejected, 'Logout must prevent sealing');
  check(JSON.stringify(await page.evaluate(() => window.harness.pending())) === JSON.stringify(pending), 'Logout must retain exact bytes');
  await page.context().setOffline(false);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.harness));
  await page.evaluate(() => window.harness.resume());
  check(JSON.stringify(await page.evaluate(() => window.harness.pending())) === JSON.stringify(pending), 'Reload must retain exact bytes');
  const second = await page.evaluate(() => window.harness.seal());
  check(second.sequence === '2', 'Rollback/reload must not consume sequence');
  const third = await page.evaluate(() => window.harness.switchIdentity());
  check(third.sequence === '3', 'Identity switch must share the device sequence');
  check((await page.evaluate(() => window.harness.pending())).find(row => row.id === first.id).envelope === pending[0].envelope, 'Identity switch changed pending bytes');
  const tab = await page.context().newPage();
  await tab.goto(url);
  await tab.waitForFunction(() => Boolean(window.harness));
  const results = await Promise.all([
    page.evaluate(async () => { try { return await window.harness.acquire('tab-a', 30_000); } catch { return null; } }),
    tab.evaluate(async () => { try { return await window.harness.acquire('tab-b', 30_000); } catch { return null; } }),
  ]);
  check(results.filter(Boolean).length === 1, 'Two tabs acquired the same device lease');
  const winner = results.find(Boolean);
  await page.evaluate(token => window.harness.release(token), winner);
  const crashed = await tab.evaluate(() => window.harness.acquire('crashed', 100));
  await tab.close();
  await page.waitForTimeout(180);
  const recovered = await page.evaluate(() => window.harness.acquire('recovered', 30_000));
  check(BigInt(recovered.fence) > BigInt(crashed.fence), 'Crash recovery must increase fence');
  const staleRejected = await page.evaluate(async token => {
    try { await window.harness.assert(token); return false; } catch { return true; }
  }, crashed);
  check(staleRejected, 'Recovered fence must reject stale writer');
  await page.evaluate(token => window.harness.release(token), recovered);
  const state = await page.evaluate(() => window.harness.state());
  check(state.head.sequence === '3' && state.pending === 3, 'Crash recovery consumed sequence or lost envelopes');
  return { passed: true, scenarios: ['offline', 'rollback', 'logout', 'reload', 'identity-switch', 'two-tabs', 'tab-crash', 'fencing'], state };
}
