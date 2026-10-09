/* global window */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const url = 'http://127.0.0.1:4179/apps/web/test/browser/opaque-delivery.html';
  const control = data => page.request.post('http://127.0.0.1:4179/test-delivery/control', { data });
  const crashed = await page.context().newPage();
  await crashed.goto(url); await crashed.waitForFunction(() => Boolean(window.deliveryHarness));
  await crashed.evaluate(() => window.deliveryHarness.initialize());
  await crashed.evaluate(() => window.deliveryHarness.enqueue());
  await crashed.evaluate(() => window.deliveryHarness.enqueue());
  const original = await crashed.evaluate(() => window.deliveryHarness.state());
  check(original.pending.length === 2 && original.records === 2, 'Fixture did not persist pending ciphertext');
  await crashed.close();
  await page.goto(url); await page.waitForFunction(() => Boolean(window.deliveryHarness));
  await page.evaluate(() => window.deliveryHarness.reopen());
  check(JSON.stringify(original) === JSON.stringify(await page.evaluate(() => window.deliveryHarness.state())), 'Tab closure changed pending bytes');
  const switched = await page.evaluate(() => window.deliveryHarness.switchIdentity());
  check(switched.denied && switched.wrongKey && switched.ownRecords === 0, 'New identity could read old content or DEK');
  check(JSON.stringify(original) === JSON.stringify(await page.evaluate(() => window.deliveryHarness.state())), 'Identity switch altered original envelopes');
  await control({ dropNext: true });
  check(await page.evaluate(async () => { try { await window.deliveryHarness.flush(); return false; } catch { return true; } }), 'Lost ACK reported success');
  check(JSON.stringify(original) === JSON.stringify(await page.evaluate(() => window.deliveryHarness.state())), 'Lost ACK deleted ciphertext');
  await page.reload(); await page.waitForFunction(() => Boolean(window.deliveryHarness));
  await control({ partialNext: true });
  check(await page.evaluate(async () => { try { await window.deliveryHarness.flush(); return false; } catch { return true; } }), 'Partial sync did not retain recoverable failure');
  const partial = await page.evaluate(() => window.deliveryHarness.state());
  check(partial.records === 1 && partial.pending.length === 1, 'Partial ACK removed unconfirmed payload');
  check(JSON.stringify(partial.pending[0]) === JSON.stringify(original.pending[1]), 'Unconfirmed envelope changed');
  const batches = (await (await control({})).json()).batches;
  check(JSON.stringify(batches.at(-3)) === JSON.stringify(batches.at(-2)), 'Retry changed the exact lost-ACK batch');
  await page.evaluate(() => window.deliveryHarness.flush());
  const final = await page.evaluate(() => window.deliveryHarness.state());
  check(final.records === 0 && final.pending.length === 0, 'Definitive signed ACK did not clean up');
  return { passed: true, browser: page.context().browser().version(), scenarios: ['tab-close-reopen', 'encrypted-records',
    'identity-switch-denied', 'wrong-dek-denied', 'lost-ack-socket', 'reload', 'exact-retry', 'partial-ack', 'unconfirmed-bytes', 'signed-final-cleanup'] };
}
