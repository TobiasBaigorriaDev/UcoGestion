/* global window, document */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  let blocked = true; const attempts = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    if (request.url().endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'csrf' } });
    if (request.url().endsWith('/deactivation-blockers')) return route.fulfill({ json: blocked
      ? { sessions: '2', pending: '3', conflicts: '1', uncertainty: '1' } : { sessions: '0', pending: '0', conflicts: '0', uncertainty: '0' } });
    if (request.url().endsWith('/deactivate')) {
      attempts.push({ key: request.headers()['idempotency-key'], version: request.headers()['if-match'], body: request.postData() });
      if (attempts.length === 1) return route.abort('failed');
      return route.fulfill({ json: { id: '44444444-4444-4444-8444-444444444444', name: 'Principal', status: 'INACTIVE', version: 2 } });
    }
    throw new Error(`Unexpected request ${request.url()}`);
  });
  await page.goto('http://127.0.0.1:4179/apps/web/test/browser/branch-deactivation.html');
  await page.getByRole('button', { name: 'Revisar desactivación de Principal' }).click();
  await page.getByText(/Incertidumbre offline: 1/).waitFor();
  check(await page.getByRole('checkbox').count() === 0, 'Blocked confirmation appeared');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => document.fonts.ready);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Branch page overflow');
    for (const link of await page.getByRole('link').all()) {
      const bounds = await link.boundingBox();
      check(bounds && bounds.height >= 44 && bounds.width >= 44, 'Branch blocker link target is smaller than 44px');
    }
    check((await page.evaluate(() => window.axe.run(document))).violations.length === 0, 'Axe failed');
    await page.screenshot({ path: `output/playwright/branch-deactivation-${width}.png`, fullPage: true });
  }
  blocked = false;
  await page.getByRole('button', { name: 'Revisar desactivación de Principal' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Desactivar Principal' }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('alert').waitFor();
  await page.getByRole('button', { name: 'Desactivar Principal' }).click();
  await page.getByText('Principal desactivada. El historial se conserva.', { exact: true }).waitFor();
  check(JSON.stringify(attempts[0]) === JSON.stringify(attempts[1]) && attempts.length === 2, 'Retry changed payload/key/version');
  await page.unroute('**/api/v1/**');
  return { passed: true, scenarios: ['blockers', 'no-hidden-confirmation', 'mobile', 'axe-with-contrast', 'keyboard', 'uncertain-exact-retry', 'confirmed'] };
}
