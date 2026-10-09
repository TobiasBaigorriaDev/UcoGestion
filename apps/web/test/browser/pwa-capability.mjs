/* global window, navigator */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const results = [];
  for (const missing of ['none', 'serviceWorker', 'indexedDB', 'crypto']) {
    const candidate = await page.context().newPage();
    const errors = []; candidate.on('pageerror', error => errors.push(error.message));
    let mutations = 0;
    await candidate.route('**/api/v1/**', route => {
      if (route.request().method() !== 'GET') mutations++;
      return route.fulfill({ json: { available: true } });
    });
    await candidate.addInitScript(capability => {
      if (capability === 'serviceWorker') Object.defineProperty(navigator, 'serviceWorker', { value: undefined });
      if (capability === 'indexedDB') Object.defineProperty(window, 'indexedDB', { value: undefined });
      if (capability === 'crypto') Object.defineProperty(window, 'crypto', { value: undefined });
    }, missing);
    await candidate.goto('http://127.0.0.1:4179/apps/web/test/browser/pwa-capability.html');
    await candidate.getByRole('button', { name: 'Consultar online' }).click();
    await candidate.getByRole('status').filter({ hasText: 'Lectura online disponible' }).waitFor();
    if (missing === 'none') await candidate.evaluate(() => window.capabilityHarness.check());
    else {
      await candidate.getByRole('button', { name: 'Autorizar offline' }).click();
      await candidate.getByRole('status').filter({ hasText: 'Offline no disponible' }).waitFor();
      check(mutations === 0, `Authorization sent without ${missing}`);
    }
    check(errors.length === 0, `Online degradation crashed without ${missing}: ${errors.join('; ')}`);
    results.push({ missing, passed: true }); await candidate.close();
  }
  return { browser: page.context().browser().version(), os: await page.evaluate(() => navigator.platform), results };
}
