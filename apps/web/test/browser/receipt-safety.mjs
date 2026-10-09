/* global window, document */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  await page.goto('http://127.0.0.1:4179/test-receipt.html');
  check(await page.locator('main').count() === 1, 'Generated receipt missing');
  check(await page.locator('script, iframe, object, embed, a').count() === 0, 'Active markup in receipt');
  check(await page.evaluate(() => !window.receiptExecuted), 'Receipt input executed');
  check((await page.locator('main').innerText()).includes('<script>'), 'Escaped input was not preserved as text');
  await page.evaluate(() => document.fonts.ready);
  return { passed: true, scenarios: ['escaped-script', 'escaped-events', 'no-active-elements', 'no-execution'] };
}
