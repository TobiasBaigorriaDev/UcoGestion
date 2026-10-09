/* global window, navigator */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const url = 'http://127.0.0.1:4179/apps/web/test/browser/offline-pos.html';
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.posHarness));
  await page.evaluate(() => window.posHarness.initialize());
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
  });
  const opening = await page.evaluate(() => window.posHarness.open());
  const draft = await page.evaluate(id => window.posHarness.prepare(id), opening.sessionId);
  const sale = await page.evaluate(id => window.posHarness.confirm(id), draft.id);
  const next = await page.evaluate(id => window.posHarness.prepare(id), opening.sessionId);
  const before = await page.evaluate(() => window.posHarness.state());
  check(await page.evaluate(async id => {
    try { await window.posHarness.freezeClose(id); return false; }
    catch (error) { return error.message === 'OFFLINE_PENDING'; }
  }, opening.sessionId), 'Close allowed a pending queue');
  const second = await page.context().newPage();
  await second.goto(url); await second.waitForFunction(() => Boolean(window.posHarness));
  await second.evaluate(() => window.posHarness.resume());
  check(await second.evaluate(async id => {
    try { await window.posHarness.confirm(id); return false; }
    catch (error) { return error.message === 'OFFLINE_SESSION_CLOSING'; }
  }, next.id), 'Another tab bypassed close freeze');
  await second.close();
  await page.context().setOffline(true);
  check(JSON.stringify(await page.evaluate(id => window.posHarness.confirm(id), draft.id)) === JSON.stringify(sale),
    'Freeze blocked sealed replay');
  await page.context().setOffline(false); await page.reload();
  await page.waitForFunction(() => Boolean(window.posHarness));
  await page.evaluate(() => window.posHarness.resume());
  check(await page.evaluate(async id => {
    try { await window.posHarness.confirm(id); return false; }
    catch (error) { return error.message === 'OFFLINE_SESSION_CLOSING'; }
  }, next.id), 'Reload lost close freeze');
  check(JSON.stringify(before.pending) === JSON.stringify((await page.evaluate(() => window.posHarness.state())).pending),
    'Close freeze changed sealed bytes');
  return { passed: true, scenarios: ['pending-denial', 'two-tabs', 'offline-replay', 'reload', 'byte-preservation'] };
}
