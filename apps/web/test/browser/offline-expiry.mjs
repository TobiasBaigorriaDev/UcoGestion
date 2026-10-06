/* global window */
// Playwright CLI consumes this expression as a serialized browser callback.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (condition,message) => { if (!condition) throw new Error(message); };
  const url = 'http://127.0.0.1:4179/apps/web/test/browser/offline-pos.html';
  await page.goto(url); await page.waitForFunction(() => Boolean(window.posHarness));
  await page.evaluate(() => window.posHarness.initialize());
  const opened = await page.evaluate(() => window.posHarness.open());
  const draft = await page.evaluate(id => window.posHarness.prepare(id),opened.sessionId);
  const before = await page.evaluate(() => window.posHarness.state());
  await page.context().setOffline(true);
  await page.evaluate(() => window.posHarness.expire());
  check(await page.evaluate(async id => { try { await window.posHarness.confirm(id); return false; } catch { return true; } },draft.id),'Expired grant accepted a sale');
  check(await page.evaluate(async () => { try { await window.posHarness.open(); return false; } catch { return true; } }),'Expired grant accepted opening');
  const expired = await page.evaluate(() => window.posHarness.state());
  check(JSON.stringify(before.pending)===JSON.stringify(expired.pending),'Expiration modified envelopes');
  check(JSON.stringify(before.head)===JSON.stringify(expired.head),'Expiration consumed sequence');
  await page.context().setOffline(false);
  await page.reload(); await page.waitForFunction(() => Boolean(window.posHarness));
  await page.evaluate(() => window.posHarness.resume());
  await page.evaluate(() => window.posHarness.rewind());
  check(await page.evaluate(async id => { try { await window.posHarness.confirm(id); return false; } catch { return true; } },draft.id),'Reload/clock rollback reactivated grant');
  const after = await page.evaluate(() => window.posHarness.state());
  check(JSON.stringify(before.pending)===JSON.stringify(after.pending),'Reload altered pending bytes');
  check((await page.evaluate(() => window.posHarness.catalog())).configuration.items.length===1,'Historical catalogue unexpectedly removed');
  return {passed:true,scenarios:['offline-expiration','no-sale','no-opening','byte-preservation','no-sequence-consumption','reload','clock-rollback','historical-catalogue']};
}
