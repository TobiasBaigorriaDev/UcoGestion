/* global window, navigator, indexedDB */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  for (const version of [1, 2]) {
  const url = 'http://127.0.0.1:4179/apps/web/test/browser/offline-pos.html';
  await page.waitForFunction(() => Boolean(window.posHarness));
  await page.evaluate(version => window.posHarness.initialize(version), version);
  // Initialize the real worker and ensure the capability gate can operate without network.
  await page.evaluate(async () => {
    try {
      await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    } catch (error) {
      throw new Error(`${error.message}; databases: ${JSON.stringify(await indexedDB.databases())}`, { cause: error });
    }
  });
  await page.context().setOffline(true);
  const opened = await page.evaluate(() => window.posHarness.open());
  const openedState = await page.evaluate(() => window.posHarness.state());
  check(openedState.pending.length === 1 && openedState.head.sequence === '1', 'Offline opening was not atomic');
  const draft = await page.evaluate(id => window.posHarness.prepare(id), opened.sessionId);
  check(version === 2 ? draft.quote.schemaVersion === 2 && draft.quote.lines[0].category.name === 'Original category'
    : !('schemaVersion' in draft.quote) && !('category' in draft.quote.lines[0]), 'Category snapshot changed schema semantics');
  check(draft.customerId === null && draft.quote.total === '10.00', 'Verified consumer final quote missing');
  check(await page.evaluate(async id => { try {
    await window.posHarness.prepare(id, { lines: [{ itemId: '11111111-1111-4111-8111-111111111111', quantity: '1', unitPrice: '0.01' }] });
    return false;
  } catch { return true; } }, opened.sessionId), 'Unsigned item price accepted');
  await page.evaluate(() => window.posHarness.fault(true));
  check(await page.evaluate(async id => { try { await window.posHarness.confirm(id); return false; } catch { return true; } }, draft.id), 'Envelope fault did not abort sale');
  const failed = await page.evaluate(() => window.posHarness.state());
  check(failed.pending.length === 1 && failed.head.sequence === '1', 'Failed envelope consumed sale sequence');
  await page.evaluate(() => window.posHarness.fault(false));
  const sale = await page.evaluate(id => window.posHarness.confirm(id), draft.id);
  check(sale.id === draft.id && sale.operationId === draft.id && sale.change === '5.00', 'Stable sale identity or cash change missing');
  const original = await page.evaluate(() => window.posHarness.state());
  check(original.pending.length === 2 && original.head.sequence === '2', 'Sale was not sealed with its payment');
  await page.evaluate(() => window.posHarness.lock());
  check(await page.evaluate(async () => { try { await window.posHarness.catalog(); return false; } catch { return true; } }), 'Logout exposed catalog');
  check(await page.evaluate(async id => { try { await window.posHarness.confirm(id); return false; } catch { return true; } }, draft.id), 'Logout exposed a sale');
  await page.context().setOffline(false);
  await page.reload(); await page.waitForFunction(() => Boolean(window.posHarness));
  await page.evaluate(() => window.posHarness.resume());
  const resumed = await page.evaluate(() => window.posHarness.state());
  check(JSON.stringify(resumed.pending) === JSON.stringify(original.pending), 'Reload changed pending envelope bytes');
  const replay = await page.evaluate(id => window.posHarness.confirm(id), draft.id);
  check(JSON.stringify(replay) === JSON.stringify(sale), 'Reload changed replay identity or reference');
  check(JSON.stringify((await page.evaluate(() => window.posHarness.state())).pending) === JSON.stringify(original.pending), 'Replay appended another sale');
  check(await page.evaluate(async () => { try { await window.posHarness.open(); return false; } catch { return true; } }), 'Reload forgot open session');
  await page.evaluate(version => window.posHarness.initialize(version), version);
  const second = await page.context().newPage();
  await second.goto(url); await second.waitForFunction(() => Boolean(window.posHarness));
  await second.evaluate(() => window.posHarness.resume());
  const result = await Promise.all([page, second].map(tab => tab.evaluate(async () => {
    try { await window.posHarness.open(); return true; } catch { return false; }
  })));
  check(result.filter(Boolean).length === 1, 'Two tabs opened duplicate sessions');
  const state = await page.evaluate(() => window.posHarness.state());
  check(state.pending.length === 1 && state.head.sequence === '1', 'Competing opening left extra effects');
  await second.close();
  }
  return { passed: true, versions: [1, 2], scenarios: ['real-worker', 'offline-opening', 'verified-prices', 'consumer-final', 'sale-rollback', 'sale-payments', 'stable-sale-replay', 'logout', 'network-return',
    'reload-byte-preservation', 'duplicate-session-rejection', 'two-tabs'] };
}
